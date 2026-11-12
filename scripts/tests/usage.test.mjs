// 账号的跨天账本：世界的日计数换天就归零、请求台账只留最近若干条，
// 所以管理服务把请求一行一行落进 SQLite（`usage.db`），过了今天也查得到、对得起来
// （纯浏览器版只有 scripts/towns/ledger.mjs 会写这份账本）。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { foldLedger, historyOf } from '../towns/usage.mjs'
import {
  addRequest,
  countRequests,
  dayRows,
  openLedger,
  openLedgerWithOld,
  pruneLedger,
  recentDays,
} from '../towns/ledger.mjs'
import { costMicros, priceOf } from '../towns/prices.mjs'

const AT = 1_700_000_000 // 2023-11-14 UTC
const owners = new Map([['r1', 'a1']])
const prices = new Map([['deepseek/deepseek-chat', { input: 2, cache: 0.5, output: 8 }]])

const sample = () => ({
  requests: [
    // 落定的：服务商报了计量，价目表里也有这个模型
    {
      id: 7,
      resident_id: 'r1',
      status: 'adopted',
      sent_at: AT,
      model: 'deepseek/deepseek-chat',
      input_tokens: 120,
      output_tokens: 30,
      cache_hit_tokens: 40,
      reserved_tokens: 200,
    },
    // 落定但没报计量：花费不明
    { id: 8, resident_id: 'r1', status: 'failed', sent_at: AT + 100, reserved_tokens: 150 },
    // 不是自己投的居民
    { id: 9, resident_id: 'r2', status: 'adopted', sent_at: AT + 100, input_tokens: 999 },
    // 还在路上：等它落定再算
    { id: 10, resident_id: 'r1', status: 'in_flight', sent_at: AT + 200 },
    // 有计量、价目表里没有这个模型：钱不知道，不折算成 0
    {
      id: 11,
      resident_id: 'r1',
      status: 'adopted',
      sent_at: AT + 300,
      model: 'someone/unknown-model',
      input_tokens: 10,
    },
  ],
})

const home = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'town-usage-'))
  return { root, done: () => rm(root, { recursive: true, force: true }) }
}

test('同一条请求折两次只算一次，没报计量的另放一栏', async () => {
  const { root, done } = await home()
  try {
    const db = openLedger(root, 'u1')
    try {
      foldLedger(db, 'town-1', sample(), owners, prices)
      foldLedger(db, 'town-1', sample(), owners, prices)
      assert.equal(countRequests(db), 3, '三条落定的请求各记一行')
      const here = dayRows(db, '2023-11-14').get('a1')
      assert.equal(here.calls, 3)
      assert.equal(here.tokens, 160, '只算服务商报回来的')
      assert.equal(here.input_tokens, 130)
      assert.equal(here.cache_hit_tokens, 40)
      assert.equal(here.unmetered, 1)
      assert.equal(here.estimated, 150, '估算值另放一栏，不混进真花掉的钱')
      // 120 输入里 40 命中：80 × 2 + 40 × 0.5 + 30 × 8 = 420 微元
      assert.equal(here.cost_micros, 420)
      assert.equal(here.priced, 1)
      assert.equal(here.unpriced, 1, '有计量没价钱的单列，不写成 0')
      assert.deepEqual([...dayRows(db, '2023-11-14').keys()], ['a1'], '别的居民不进这个账号的账本')

      // 换天以后世界那边归零了，最近的账还在这里
      foldLedger(
        db,
        'town-1',
        {
          requests: [
            {
              id: 1,
              resident_id: 'r1',
              status: 'adopted',
              sent_at: AT + 86_400 * 2,
              input_tokens: 10,
            },
          ],
        },
        owners,
        prices
      )
      const week = historyOf(recentDays(db, 7), new Map([['a1', '阿岚']]))
      assert.deepEqual(
        week.map((day) => day.day),
        ['2023-11-16', '2023-11-14'],
        '新的在前'
      )
      assert.equal(week[1].calls, 3)
      assert.equal(week[1].cost_micros, 420)
      assert.equal(week[1].unpriced, 1)
      assert.equal(week[0].agents[0].name, '阿岚')
    } finally {
      db.close()
    }
  } finally {
    await done()
  }
})

test('价目表按三档单价算钱，只写模型名也认', () => {
  const prices = new Map([['deepseek/deepseek-chat', { input: 2, cache: 0.5, output: 8 }]])
  // 1M 输入（其中 400k 命中）+ 200k 输出 = 1.2 + 0.2 + 1.6 = 3 元
  assert.equal(costMicros(prices, 'deepseek/deepseek-chat', 1_000_000, 400_000, 200_000), 3_000_000)
  assert.equal(costMicros(prices, 'deepseek-chat', 1_000_000, 0, 0), 2_000_000)
  assert.equal(costMicros(prices, 'mock/agent-wiring-fixture', 1, 0, 1), null, '没价就是没价')
  assert.equal(costMicros(prices, undefined, 1, 0, 1), null)
  assert.equal(priceOf(prices, 'deepseek-chat')?.output, 8)
})

test('账本存得住：重开还是那几天，旧 usage.json 导进来就改名留底', async () => {
  const { root, done } = await home()
  try {
    const db = openLedger(root, 'u1')
    foldLedger(db, 'town-1', sample(), owners, prices)
    db.close()
    const back = openLedger(root, 'u1')
    assert.equal(countRequests(back), 3)
    assert.equal(dayRows(back, '2023-11-14').get('a1').calls, 3)
    back.close()
    const files = await readdir(path.join(root, 'users', 'u1'))
    assert.deepEqual(files, ['usage.db'], '存成一份 usage.db，不散落')

    // 旧版本的 usage.json：第一次打开时导进日账，然后改名
    const old = path.join(root, 'users', 'u2')
    await mkdir(old, { recursive: true })
    await writeFile(
      path.join(old, 'usage.json'),
      JSON.stringify({
        days: { '2023-11-13': { a1: { calls: 5, tokens: 600, cost_micros: 900 } } },
      })
    )
    const imported = await openLedgerWithOld(root, 'u2')
    assert.equal(dayRows(imported, '2023-11-13').get('a1').calls, 5)
    assert.equal(dayRows(imported, '2023-11-13').get('a1').cost_micros, 900)
    imported.close()
    const after = await readdir(path.join(root, 'users', 'u2'))
    assert.deepEqual(after.sort(), ['usage.db', 'usage.json.imported'], '旧文件改名留底')
  } finally {
    await done()
  }
})

test('旧日子连请求行一起清掉', async () => {
  const { root, done } = await home()
  try {
    const db = openLedger(root, 'u1')
    const entry = (day, requestId) => ({
      town: 'town-1',
      request_id: requestId,
      resident: 'r1',
      agent: 'a1',
      day,
      sent_at: AT,
      model: null,
      status: 'adopted',
      input: 0,
      cache: 0,
      output: 0,
      reserved: 0,
      metered: false,
      cost: null,
    })
    addRequest(db, entry('2023-10-01', '1'))
    addRequest(db, entry('2023-11-13', '2'))
    pruneLedger(db, '2023-11-01')
    assert.equal(countRequests(db), 1)
    assert.equal(dayRows(db, '2023-10-01').size, 0)
    assert.equal(dayRows(db, '2023-11-13').size, 1)
    db.close()
  } finally {
    await done()
  }
})
