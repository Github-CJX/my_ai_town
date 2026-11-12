// 「我的用量」的口径：数字怎么读、缓存命中怎么算、钱算不出来时怎么说。
// 这些文字会直接出现在玩家眼前，写错就变成「花了 ¥0」「100% 命中」这类假话，
// 所以把它们和 DOM 分开（accountUsage/report.ts 不引样式），单独编译再断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

let loading = null

function load() {
  loading ??= (async () => {
    const dir = path.join(root, 'target', 'tmp', 'account-usage-check')
    fs.mkdirSync(dir, { recursive: true })
    const tsc = path.join(root, 'frontend/town-shared/node_modules/typescript/bin/tsc')
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        path.join(root, 'frontend/town-shared/src/accountUsage/report.ts'),
        path.join(root, 'frontend/town-shared/src/pricing.ts'),
        '--target',
        'ES2022',
        '--module',
        'esnext',
        '--moduleResolution',
        'bundler',
        '--skipLibCheck',
        '--outDir',
        dir,
      ],
      { encoding: 'utf8' }
    )
    const output = `${result.stdout}${result.stderr}`
    const own = output
      .split(/\r?\n/)
      .filter(
        (line) =>
          (line.includes('report.ts') || line.includes('pricing.ts')) && line.includes('error TS')
      )
    assert.deepEqual(own, [], output)
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
    return {
      report: await import(pathToFileURL(path.join(dir, 'accountUsage', 'report.js')).href),
      pricing: await import(pathToFileURL(path.join(dir, 'pricing.js')).href),
    }
  })()
  return loading
}

test('一万以下照实数，一万以上按 k 说：不给「1.0k」和「12k」两种粒度混在一起', async () => {
  const { report } = await load()
  assert.equal(report.countText(0), '0')
  assert.equal(report.countText(850), '850')
  assert.equal(report.countText(1234), '1.2k')
  assert.equal(report.countText(9999), '10.0k')
  assert.equal(report.countText(12345), '12k')
  assert.equal(report.countText(Number.NaN), '0')
  assert.equal(report.tokenText(850), '850 token')
})

test('钱：一分钱以下说「不到 ¥0.01」，不能写成 ¥0（那看起来像没花钱）', async () => {
  const { report, pricing } = await load()
  assert.equal(report.moneyText(0), '¥0')
  assert.equal(report.moneyText(5000), '不到 ¥0.01')
  assert.equal(report.moneyText(120000), '¥0.12')
  assert.equal(report.moneyText(2_500_000), '¥2.50')
  // 与消耗页的 yuan() 是同一个口径：两处说法不一致，玩家会以为是两笔账
  for (const micros of [0, 5000, 120000, 2_500_000, 10_000_000])
    assert.equal(report.moneyText(micros), pricing.yuan(micros / 1_000_000))
})

test('缓存命中：没有输入就没有分母，写「—」；命中数不可能超过输入', async () => {
  const { report } = await load()
  assert.equal(report.hitText(0, 0), '—')
  assert.equal(report.hitText(50, 200), '25%')
  assert.equal(report.hitText(300, 200), '100%')
  assert.equal(report.hitText(-5, 200), '0%')
})

test('账本里的日期只写月日；不是日期的原样留着', async () => {
  const { report } = await load()
  assert.equal(report.dayText('2026-11-12'), '11-12')
  assert.equal(report.dayText('昨天'), '昨天')
})

test('近几天合计：调用、token、缓存、钱各自加，天数照实数', async () => {
  const { report } = await load()
  const sum = report.weekOf([
    {
      day: '2026-11-12',
      calls: 3,
      tokens: 1000,
      input_tokens: 900,
      cache_hit_tokens: 300,
      unmetered: 0,
      cost_micros: 1200,
      priced: 3,
      unpriced: 0,
    },
    {
      day: '2026-11-11',
      calls: 2,
      tokens: 500,
      input_tokens: 400,
      cache_hit_tokens: 100,
      unmetered: 0,
      cost_micros: 800,
      priced: 2,
      unpriced: 0,
    },
  ])
  assert.deepEqual(sum, {
    days: 2,
    calls: 5,
    tokens: 1500,
    input_tokens: 1300,
    cache_hit_tokens: 400,
    cost_micros: 2000,
  })
  assert.equal(report.weekOf([]).days, 0)
})

test('一位 agent 的状态：没在小镇里跑就直说「不知道」，别当成 0 花销', async () => {
  const { report } = await load()
  const base = {
    name: '阿明',
    town_name: '示例镇',
    resident_name: '阿明',
    running: true,
    paused: null,
    calls: 1,
    tokens: 10,
    input_tokens: 10,
    cache_hit_tokens: 0,
    in_flight: 0,
    unmetered: 0,
    replies: 0,
    cost_micros: 0,
  }
  assert.deepEqual(report.rowState({ ...base, running: false }), { text: '小镇没在跑', cls: 'dim' })
  assert.deepEqual(report.rowState({ ...base, paused: '额度用尽' }), { text: '已停', cls: 'drop' })
  assert.deepEqual(report.rowState({ ...base, in_flight: 2 }), { text: '在途 2', cls: 'busy' })
  assert.deepEqual(report.rowState(base), { text: '正常', cls: 'ok' })
})

test('额度：没设的那几项是「照小镇的」，不是「不限」', async () => {
  const { report } = await load()
  assert.equal(report.budgetText({}), '每天 照小镇的次数 · token 照小镇的额度')
  assert.equal(
    report.budgetText({
      calls_per_day: 30,
      tokens_per_day: 500000,
      max_concurrent: 2,
      per_minute: 20,
    }),
    '每天 30 次 · token 500k · 同时 2 件事 · 每分钟 20 次'
  )
})

test('钱算不全时把两种原因分开说：没回计量和价目表里没有是两件事', async () => {
  const { report } = await load()
  assert.equal(report.missingText({}), '')
  assert.equal(report.missingText({ unpriced: 2 }), '2 次价目表里没有，钱没算全')
  assert.equal(
    report.missingText({ unmetered: 1, unpriced: 2 }),
    '1 次服务商没回计量、2 次价目表里没有，钱没算全'
  )
})
