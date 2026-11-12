// 名册播放时钟：一份名册在时间轴上占多久，按它代表世界走了几拍算，到货快慢只用来放慢。
// 这条是「村民卡一下又窜一下」的回归防线：按到达间隔加时间轴时，一次收好几份会把那段路压短，
// 立牌就一小段冲刺（见手册 D.47）。仓库里没有前端测试运行时，像 grid.test.mjs 一样单独编译再导入。
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
    const dir = path.join(root, 'target', 'tmp', 'playback-check')
    fs.mkdirSync(dir, { recursive: true })
    const tsc = path.join(root, 'frontend/town-shared/node_modules/typescript/bin/tsc')
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        path.join(root, 'frontend/town-2d/src/map/hd2d/playback.ts'),
        '--target',
        'ES2022',
        '--module',
        'ES2022',
        '--skipLibCheck',
        '--outDir',
        dir,
      ],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
    return import(pathToFileURL(path.join(dir, 'playback.js')).href)
  })()
  return loading
}

/** 与 villagers.ts 里那一组常量一致 */
const options = {
  tickMs: 100,
  minutesPerTick: 0.1,
  maxStepMs: 1000,
  delayMs: 350,
  resyncMs: 900,
  windowMs: 1000,
  minRate: 0.85,
  maxRate: 1.05,
  maxDrift: 0.1,
}
const FRAME_MS = 16.7
/** 播放速度的上下限：drift 与缓冲修正叠在一起 */
const SLOWEST = options.minRate * (1 - options.maxDrift)
const FASTEST = options.maxRate * (1 + options.maxDrift)

/** 喂一串到货（at 毫秒、minutes 世界分钟数、pace 可省）与每帧时间，返回每一帧之后的时钟 */
function play(arrivals, untilMs, Clock) {
  const clock = new Clock(options)
  const frames = []
  let next = 0
  for (let t = 0; t <= untilMs; t += FRAME_MS) {
    while (next < arrivals.length && arrivals[next].at <= t) {
      const a = arrivals[next]
      clock.arrive(a.at, { minutes: a.minutes, pace: a.pace ?? 1 })
      next++
    }
    const before = clock.play
    clock.advance(FRAME_MS)
    frames.push({
      t,
      play: clock.play,
      moved: clock.play - before,
      rate: clock.rate,
      latest: clock.latest,
    })
  }
  return frames
}

/** 浮点的分钟数相减会带尾差，比较时间轴长度时留一点余量 */
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}：${actual} ≠ ${expected}`)
}

/** 服务端正常 10 Hz：每 100 毫秒一份、每份推进 0.1 分钟 */
function steady(fromTick, count, at = (k) => k * 100) {
  return Array.from({ length: count }, (_, i) => ({
    at: at(i),
    minutes: (fromTick + i) * 0.1,
  }))
}

test('一次收好几份名册不会让播放加速，也不会让人冻住', async () => {
  const { PlaybackClock } = await load()
  // 前 3 秒正常到货；3.0 秒卡住，3.4 秒时积下的四份一起到；之后恢复
  const arrivals = [
    ...steady(0, 31),
    ...steady(31, 4, () => 3400),
    ...steady(35, 40, (k) => 3400 + k * 100),
  ]
  const frames = play(arrivals, 7000, PlaybackClock)

  // 每一帧走的距离都只由这一帧的时间与速度决定：没有任何一段被压成几倍速
  let fastest = 0
  for (const f of frames) {
    assert.ok(f.rate >= SLOWEST - 1e-9, `播放太慢：${f.rate}`)
    assert.ok(f.rate <= FASTEST + 1e-9, `播放太快：${f.rate}（一次收好几份时窜了）`)
    const moved = f.moved / FRAME_MS
    assert.ok(moved <= FASTEST + 1e-6, `这一帧跑了 ${moved.toFixed(2)} 倍速`)
    fastest = Math.max(fastest, moved)
  }
  assert.ok(fastest > 0.4, '播放根本没动')

  // 没被卡死：最后缓冲仍是两拍上下，不是越落越远也不是一次跳到最前
  const last = frames[frames.length - 1]
  const buffered = last.latest - last.play
  assert.ok(buffered > 50 && buffered < 450, `缓冲 ${buffered.toFixed(0)} 毫秒，播放跟丢了`)
})

test('被覆盖掉的那几份按世界时间补回时间轴，不按到达间隔压短', async () => {
  const { PlaybackClock } = await load()
  const clock = new PlaybackClock(options)
  for (const a of steady(0, 5)) clock.arrive(a.at, { minutes: a.minutes, pace: 1 })
  const before = clock.latest
  // 断了四份，这四拍代表的世界时间是 400 毫秒（旧写法只按到达间隔 0 算，会被钳到 40 毫秒）
  clock.arrive(5000, { minutes: 0.8, pace: 1 })
  near(clock.latest - before, 400, '丢掉的那四拍没算进时间轴')
  // 一口气送来时同样按世界时间算，不越算越快
  clock.arrive(5000, { minutes: 0.9, pace: 1 })
  clock.arrive(5000, { minutes: 1.0, pace: 1 })
  near(clock.latest - before, 600, '连着到的几份没按世界时间累加')
})

test('世界停着的时候时间轴也停，不白走', async () => {
  const { PlaybackClock } = await load()
  const clock = new PlaybackClock(options)
  clock.arrive(0, { minutes: 1.0, pace: 1 })
  const at = clock.latest
  // 用户暂停：pace 为零，模拟时间不再推进（一分都不多）
  clock.arrive(1000, { minutes: 1.0, pace: 0 })
  clock.arrive(2000, { minutes: 1.0, pace: 0 })
  assert.equal(clock.latest, at, '世界停着时间轴却往前走了')
  // 恢复：接着往后走，暂停的那两秒不算
  clock.arrive(3000, { minutes: 1.1, pace: 1 })
  near(clock.latest - at, 100, '恢复后没有接着往前走')
})

test('落后超过上限才跳到最新，跳完仍保留 350ms 缓冲', async () => {
  const { PlaybackClock } = await load()
  const clock = new PlaybackClock(options)
  // 前 1 秒正常到货
  for (const a of steady(0, 11)) {
    clock.arrive(a.at, { minutes: a.minutes, pace: 1 })
    clock.advance(100)
  }
  assert.ok(clock.latest - clock.play < 600, '不该重对齐时重对齐了')
  // 断线十秒：这段时间一帧都没画，回来一份就跳（世界走了多少超出上限，直接跳到最新）
  clock.arrive(11000, { minutes: 11.0, pace: 1 })
  assert.equal(clock.play, clock.latest - options.delayMs)
  assert.equal(clock.rate, 1)
})
