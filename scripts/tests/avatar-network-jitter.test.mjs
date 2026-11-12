import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../frontend/town-2d/package.json', import.meta.url))
const ts = require('typescript')

function load(relative, exportName) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
  const scope = { exports: {}, performance: { now: () => 0 } }
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    scope
  )
  return scope.exports[exportName]
}
const at = (x, y) => ({ space: 'outside', position: [x, y] })

test('网络积压连续发来旧位置，不会按「六拍」误判卡住、狂重规划', () => {
  const createWalkTo = load('../../frontend/town-shared/src/avatar/walkTo.ts', 'createWalkTo')
  let time = 1000
  let here = at(0, 0)
  let replans = 0
  const walk = createWalkTo({
    here: () => here,
    now: () => time,
    step: () => 0.25,
    canWalk: () => true,
    emit: () => {},
    portal: async () => true,
    replan: () => {
      replans++
      return [{ point: at(10, 0) }]
    },
    end: () => {},
  })
  walk.set([{ point: at(10, 0) }], 0.5)
  for (let i = 0; i < 20; i++) {
    time += 15
    walk.tick()
  }
  assert.equal(replans, 0, '300ms 内连收 20 份旧快照不应触发改道')
  time += 1500
  walk.tick()
  assert.equal(replans, 1, '超过 1.3s 仍不移动时应重新选路')
})

test('重新选路时先停下旧路线的续发方向', () => {
  const createWalkTo = load('../../frontend/town-shared/src/avatar/walkTo.ts', 'createWalkTo')
  let time = 1000
  const emitted = []
  const walk = createWalkTo({
    here: () => at(0, 0),
    now: () => time,
    step: () => 0.2,
    canWalk: () => true,
    emit: (d) => emitted.push([...d]),
    portal: async () => true,
    replan: () => [{ point: at(0, 10) }],
    end: () => {},
  })
  walk.set([{ point: at(10, 0) }], 0.5)
  walk.tick()
  assert.ok(emitted.at(-1)[0] > 0)
  time += 1400
  walk.tick()
  assert.deepEqual(emitted.at(-1), [0, 0], '改道时不应继续沿着已经走不通的旧方向')
  walk.keepAlive()
  assert.deepEqual(emitted.at(-1), [0, 0], '尚未确定新方向时，续发仍应为零')
  time += 100
  walk.tick()
  assert.ok(emitted.at(-1)[1] > 0, '下一次状态确认后才沿新路行走')
})

test('行走期间迟来的服务端快照超出 2.5 米，不再瞬间传送回去', () => {
  const AvatarMotion = load('../../frontend/town-2d/src/map/avatarMotion.ts', 'AvatarMotion')
  const motion = new AvatarMotion(() => true)
  motion.sample(at(0, 0), 1000)
  motion.command([1, 0], 1, 1000)
  motion.current(1100)
  const before = motion.current(1100).position[0]
  motion.sample(at(7, 0), 1101)
  const after = motion.current(1117).position[0]
  assert.ok(after - before < 0.15, `一次慢到的快照不能让人跳近 7 米：${after - before}`)
  assert.ok(after >= before, '仍应温和朝权威坐标校正')
})

test('续发定时器短暂超过 350ms 后，迟来的快照也不应直接跳坐标', () => {
  const AvatarMotion = load('../../frontend/town-2d/src/map/avatarMotion.ts', 'AvatarMotion')
  const motion = new AvatarMotion(() => true)
  motion.sample(at(0, 0), 1000)
  motion.command([1, 0], 1, 1000)
  const before = motion.current(1500).position[0]
  motion.sample(at(7, 0), 1501)
  const after = motion.current(1517).position[0]
  assert.ok(after - before < 0.2, '输入刚过期时的位置差不应被误认为传送')
})

test('静止时同空间的真实传送仍应立即同步', () => {
  const AvatarMotion = load('../../frontend/town-2d/src/map/avatarMotion.ts', 'AvatarMotion')
  const motion = new AvatarMotion(() => true)
  motion.sample(at(0, 0), 1000)
  motion.sample(at(7, 0), 1100)
  assert.equal(motion.current(1100).position[0], 7)
})

test('导航决策只读取服务端权威位置，预测仅用于画面', () => {
  const source = fs.readFileSync(
    new URL('../../frontend/town-shared/src/avatar/navigation.ts', import.meta.url),
    'utf8'
  )
  const hereCode = source.slice(
    source.indexOf('const herePoint ='),
    source.indexOf('// 走到目标后', source.indexOf('const herePoint ='))
  )
  assert.match(hereCode, /getState\(\)/)
  assert.doesNotMatch(hereCode, /avatarAt/)
})
