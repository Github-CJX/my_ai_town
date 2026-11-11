// 账号的跨天账本：世界的日计数换天就归零、请求台账只留最近若干条，
// 所以管理服务按请求号去重地留一份，过了今天也查得到
// （scripts/towns/usage.mjs / crates/manager/src/usage.rs 同一套规则）。
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { foldLedger, historyOf, pruneLedger, readLedger, saveLedger } from '../towns/usage.mjs'

const AT = 1_700_000_000 // 2023-11-14 UTC
const owners = new Map([['r1', 'a1']])

const sample = () => ({
  requests: [
    // 落定的：服务商报了计量
    {
      id: 7,
      resident_id: 'r1',
      status: 'adopted',
      sent_at: AT,
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
  ],
})

test('同一条请求折两次只算一次，没报计量的另放一栏', () => {
  const ledger = { days: {}, seen: {} }
  foldLedger(ledger, 'town-1', sample(), owners)
  foldLedger(ledger, 'town-1', sample(), owners)
  assert.equal(Object.keys(ledger.seen).length, 2)
  const here = ledger.days['2023-11-14'].a1
  assert.equal(here.calls, 2)
  assert.equal(here.tokens, 150, '只算服务商报回来的')
  assert.equal(here.input_tokens, 120)
  assert.equal(here.cache_hit_tokens, 40)
  assert.equal(here.unmetered, 1)
  assert.equal(here.estimated, 150, '估算值另放一栏，不混进真花掉的钱')
  assert.deepEqual(Object.keys(ledger.days['2023-11-14']), ['a1'], '别的居民不进这个账号的账本')

  // 换天以后世界那边归零了，最近的账还在这里
  foldLedger(
    ledger,
    'town-1',
    {
      requests: [
        { id: 1, resident_id: 'r1', status: 'adopted', sent_at: AT + 86_400 * 2, input_tokens: 10 },
      ],
    },
    owners
  )
  const week = historyOf(ledger, 7, new Map([['a1', '阿岚']]))
  assert.deepEqual(
    week.map((day) => day.day),
    ['2023-11-16', '2023-11-14'],
    '新的在前'
  )
  assert.equal(week[1].calls, 2)
  assert.equal(week[0].agents[0].name, '阿岚')
})

test('账本存得住：读回来还是那几天', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'town-usage-'))
  try {
    const ledger = { days: {}, seen: {} }
    foldLedger(ledger, 'town-1', sample(), owners)
    await saveLedger(root, 'u1', ledger)
    const back = await readLedger(root, 'u1')
    assert.deepEqual(back, ledger)
    // 文件不在时当空账本，不是报错
    assert.deepEqual(await readLedger(root, 'u2'), { days: {}, seen: {} })
    const files = await readdir(path.join(root, 'users', 'u1'))
    assert.deepEqual(files, ['usage.json'], '存成一份 usage.json，不散落')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('旧日子和旧请求号会被清掉', () => {
  const ledger = {
    days: {
      '2023-10-01': {
        a1: {
          calls: 1,
          tokens: 1,
          input_tokens: 1,
          cache_hit_tokens: 0,
          unmetered: 0,
          estimated: 0,
        },
      },
      '2023-11-13': {
        a1: {
          calls: 1,
          tokens: 1,
          input_tokens: 1,
          cache_hit_tokens: 0,
          unmetered: 0,
          estimated: 0,
        },
      },
    },
    seen: { old: AT - 20 * 86_400, recent: AT - 86_400 },
  }
  pruneLedger(ledger, AT)
  assert.equal(ledger.days['2023-10-01'], undefined)
  assert.ok(ledger.days['2023-11-13'])
  assert.equal(ledger.seen.old, undefined)
  assert.equal(ledger.seen.recent, AT - 86_400)
})
