// 本地预测的「被挡住」门槛：服务端每秒存盘那一下会停 0.23–0.47 秒（见手册 D.49），
// 门槛压在它下面，那停顿的名册一到就被判成被挡住，人停住往回补再继续走——看上去就是「走两秒顿一下」。
// 这条是那道回归防线：名册迟来 0.4 秒时脚步不停、也不往回拉；真停住 1.5 秒才停。
// 仓库里没有前端测试运行时，像 playback.test.mjs 一样单独编译再导入。
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
    const dir = path.join(root, 'target', 'tmp', 'avatar-motion-check')
    fs.mkdirSync(dir, { recursive: true })
    const tsc = path.join(root, 'frontend/town-shared/node_modules/typescript/bin/tsc')
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        path.join(root, 'frontend/town-2d/src/map/avatarMotion.ts'),
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
    // 单文件编译不读包里的 tsconfig：别的模块可能有只在这种模式下才报的错（本项目 typecheck 是干净的），
    // 只要求被测文件自己没报错。
    const output = `${result.stdout}${result.stderr}`
    const own = output
      .split(/\r?\n/)
      .filter((line) => line.includes('avatarMotion.ts') && line.includes('error TS'))
    assert.deepEqual(own, [], output)
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
    return import(pathToFileURL(path.join(dir, 'avatarMotion.js')).href)
  })()
  return loading
}

/** 一秒走多少米（和服务端 normal_pace 无关，这个文件里只用本地发出的速度） */
const SPEED = 0.9
/** 一帧多长（毫秒）：约 60 帧 */
const FRAME_MS = 16.7
/** 名册正常多久来一份（毫秒） */
const ROSTER_MS = 100

/** 站着都能走（不做撞墙判断，测的是时间轴） */
const clear = () => true

/** 每 FRAME_MS 推进一帧，把那一刻的位置记下来。input.ts 是每 0.1 秒重发一次方向，
 *  commandAt 过期（INPUT_TIMEOUT_MS）就不再算「正按它走」，所以这里也照 0.1 秒重发。 */
function frames(motion, from, to, step, tick, state) {
  const out = []
  for (let now = from; now <= to; now += step) {
    if (now - state.commandedAt >= ROSTER_MS) {
      motion.command([1, 0], SPEED, now)
      state.commandedAt = now
    }
    tick?.(now)
    out.push({ now, pos: [...motion.current(now).position], walking: motion.walking() })
  }
  return out
}

test('名册迟来 0.4 秒：脚步不停，也不往回拉', async () => {
  const { AvatarMotion } = await load()
  const motion = new AvatarMotion(clear)
  const start = 1000
  motion.sample({ space: 's', position: [0, 0] }, start)
  motion.command([1, 0], SPEED, start)
  const state = { commandedAt: start }
  // 正常走到 1.1 秒：每 0.1 秒来一份名册，位置跟着本地走
  const before = frames(
    motion,
    start + FRAME_MS,
    start + ROSTER_MS,
    FRAME_MS,
    (now) => {
      if (now >= start + ROSTER_MS) {
        motion.sample({ space: 's', position: [SPEED * 0.1, 0] }, now)
      }
    },
    state
  )
  const atStall = before[before.length - 1]
  // 服务端存盘，名册停 0.4 秒：这段时间里本地照原速往前
  const during = frames(
    motion,
    atStall.now + FRAME_MS,
    atStall.now + 400,
    FRAME_MS,
    undefined,
    state
  )
  for (const f of during) {
    assert.equal(f.walking, true, `${f.now.toFixed(0)}ms 不该停下`)
  }
  // 一直往前走，没有被判成「被挡住」而冻住
  const travelled = during[during.length - 1].pos[0] - atStall.pos[0]
  const expected = (during[during.length - 1].now - atStall.now) * (SPEED / 1000)
  assert.ok(
    Math.abs(travelled - expected) < 0.02,
    `0.4 秒里应当走 ${expected.toFixed(3)} 米，实际 ${travelled.toFixed(3)}`
  )
  // 停顿结束的那份名册到了：服务端按真实经过的时间已经补上这段路，位置在前方
  const resumed = during[during.length - 1].now + FRAME_MS
  const caught = atStall.pos[0] + (resumed - atStall.now) * (SPEED / 1000)
  motion.sample({ space: 's', position: [caught, 0] }, resumed)
  assert.equal(motion.walking(), true, '补上的名册不该让人停下')
  const after = frames(
    motion,
    resumed + FRAME_MS,
    resumed + 5 * FRAME_MS,
    FRAME_MS,
    undefined,
    state
  )
  for (const f of after) {
    assert.ok(
      f.pos[0] >= caught - 0.02,
      `不该往回拉：${f.pos[0].toFixed(3)} < ${caught.toFixed(3)}`
    )
  }
})

test('名册迟来 0.4 秒、位置还没补上：不算被挡住', async () => {
  const { AvatarMotion } = await load()
  const motion = new AvatarMotion(clear)
  const start = 1000
  motion.sample({ space: 's', position: [0, 0] }, start)
  motion.command([1, 0], SPEED, start)
  const state = { commandedAt: start }
  // 停之前先来一份名册：位置往前走了 0.09 米（原来是 0），空档里「没动」才有得比
  frames(motion, start + FRAME_MS, start + ROSTER_MS - FRAME_MS, FRAME_MS, undefined, state)
  motion.sample({ space: 's', position: [SPEED * 0.1, 0] }, start + ROSTER_MS)
  assert.equal(motion.walking(), true, '停之前还在走')
  // 存盘那 0.4 秒里名册一份都没来，本地照原速往前走
  const during = frames(
    motion,
    start + ROSTER_MS + FRAME_MS,
    start + ROSTER_MS + 400,
    FRAME_MS,
    undefined,
    state
  )
  const resumed = during[during.length - 1].now + FRAME_MS
  // 恢复后的第一份名册报的还是停之前的位置（这段时间服务端还没把路补进坐标）：
  // 空档本身不能算「被挡住」，否则每秒都会停一下。
  motion.sample({ space: 's', position: [SPEED * 0.1, 0] }, resumed)
  assert.equal(
    motion.walking(),
    true,
    `空档 ${(resumed - start - ROSTER_MS).toFixed(0)}ms 不该判成被挡住（STUCK_MS 得压过存盘的 0.23–0.47 秒）`
  )
})

test('服务端真被挡住 1.5 秒：本地停下等校正', async () => {
  const { AvatarMotion } = await load()
  const motion = new AvatarMotion(clear)
  const start = 1000
  motion.sample({ space: 's', position: [0, 0] }, start)
  motion.command([1, 0], SPEED, start)
  // 名册一直在发，位置却不动
  let still = null
  const state = { commandedAt: start }
  const frozen = frames(
    motion,
    start + FRAME_MS,
    start + 1500,
    ROSTER_MS,
    (now) => {
      if (now >= start + ROSTER_MS) motion.sample({ space: 's', position: [0, 0] }, now)
      still = now
    },
    state
  )
  assert.ok(still >= start + 1400, '名册一直在发')
  const last = frozen[frozen.length - 1]
  assert.equal(last.walking, false, '1.5 秒没动之后应当停下')
  // 停下之后位置不再往前冲，只等校正
  const after = frames(
    motion,
    last.now + FRAME_MS,
    last.now + 20 * FRAME_MS,
    FRAME_MS,
    undefined,
    state
  )
  const drift = Math.abs(after[after.length - 1].pos[0] - last.pos[0])
  assert.ok(drift < 0.05, `停下后不该再走：${drift.toFixed(3)} 米`)
})

test('浏览器卡帧 400ms：本地仍须走完服务端实际接受的 350ms 输入，不能只算末尾 250ms', async () => {
  const { AvatarMotion } = await load()
  const motion = new AvatarMotion(clear)
  motion.sample({ space: 's', position: [0, 0] }, 1000)
  motion.command([1, 0], 2, 1000)
  const p = motion.current(1400).position
  // 世界端 INPUT_TIMEOUT = 350ms，所以这一段服务端只走了 0.7 米
  assert.ok(Math.abs(p[0] - 0.7) < 0.002, `预测必须追到 0.7 米，当前 ${p[0]}`)
})

test('浏览器长时间没输入：不能把过期的方向延长到当前时刻', async () => {
  const { AvatarMotion } = await load()
  const motion = new AvatarMotion(clear)
  motion.sample({ space: 's', position: [0, 0] }, 1000)
  motion.command([1, 0], 1, 1000)
  const p = motion.current(5000).position
  assert.ok(Math.abs(p[0] - 0.35) < 0.002, `只能走 350ms，不能把后台那 4 秒都走掉：${p[0]}`)
})
