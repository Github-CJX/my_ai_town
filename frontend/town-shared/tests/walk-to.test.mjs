// 点击移动的方向选择只认世界确认的位置（不是本地预测）：预测和服务端会因为输入到达时间、
// 位置校正而差一点，拿预测来选方向就会「前进 → 回拉 → 转向 → 再前进」，看上去各方向抽动、走不到标点。
// 这两条是那道回归防线：走不动要重新选路（而不是一直往前推）；位置小幅校正不该改方向、也不该重新选路。
// 仓库里没有前端测试运行时，像 avatarMotion.test.mjs 一样单独编译再导入。
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
    const dir = path.join(root, 'target', 'tmp', 'walk-to-check')
    fs.mkdirSync(dir, { recursive: true })
    const tsc = path.join(root, 'frontend/town-shared/node_modules/typescript/bin/tsc')
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        path.join(root, 'frontend/town-shared/src/avatar/walkTo.ts'),
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
      .filter((line) => line.includes('walkTo.ts') && line.includes('error TS'))
    assert.deepEqual(own, [], output)
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
    return import(pathToFileURL(path.join(dir, 'avatar', 'walkTo.js')).href)
  })()
  return loading
}

/** 一拍走多少米（服务端 normal_pace 的一拍） */
const STEP = 0.1
/** 目标点：正东 10 米 */
const TARGET = { space: 'outdoor', position: [10, 0] }

/** 搭一个走到 TARGET 的 walkTo：位置由调用方给，方便模拟「校正」与「走不动」 */
function walker({ here, replan = () => null, stop = 0.5 }) {
  const emitted = []
  const ends = []
  const replans = []
  const walk = createWalkTo({
    here,
    step: () => STEP,
    canWalk: () => true,
    emit: (direction) => emitted.push([...direction]),
    portal: async () => true,
    replan: (to) => {
      replans.push(to)
      return replan(to)
    },
    end: (reason) => ends.push(reason),
  })
  walk.set([{ point: TARGET }], stop)
  return { walk, emitted, ends, replans }
}

let createWalkTo = null

test('世界确认的位置不再前进：重新选路，换不出来就算走不过去', async () => {
  createWalkTo ??= (await load()).createWalkTo
  // 位置停在离目标 5 米处不动：方向一直发得出去，但人没在动
  const { walk, emitted, ends, replans } = walker({
    here: () => ({ space: 'outdoor', position: [5, 0] }),
  })
  for (let tick = 0; tick < 6; tick += 1) walk.tick()
  assert.equal(replans.length, 0, '前五拍还在走，不该重新选路')
  walk.tick()
  assert.deepEqual(
    replans.map((to) => to.position),
    [[10, 0]],
    '连续 6 拍几乎没动就该重新选一次路'
  )
  assert.deepEqual(ends, ['blocked'], '换不出新路线就算走不过去，不要一直往前推')
  assert.deepEqual(emitted.at(-1), [0, 0], '放弃时要发出停下的方向')
})

test('位置小幅校正不改方向、也不重新选路，到了就停', async () => {
  createWalkTo ??= (await load()).createWalkTo
  // 位置按真实进度推进，但每拍带一点横向/纵向抖动：这是世界确认位置被校正的样子
  let at = 0
  let side = 1
  const { walk, emitted, ends, replans } = walker({
    here: () => {
      at = Math.min(TARGET.position[0], at + STEP)
      side = -side
      return { space: 'outdoor', position: [at, side * 0.12] }
    },
  })
  const forward = []
  for (let tick = 0; tick < 200 && !ends.length; tick += 1) {
    const before = emitted.length
    walk.tick()
    if (emitted.length > before) {
      const [x, y] = emitted.at(-1)
      if (x || y) forward.push([x, y])
    }
  }
  assert.deepEqual(ends, ['arrived'], '应当走到目标')
  assert.deepEqual(replans, [], '位置校正不该触发重新选路')
  for (const [x, y] of forward) {
    assert.ok(x > 0, `方向应当一直朝东，实际 ${x.toFixed(3)},${y.toFixed(3)}`)
    assert.ok(Math.abs(y) < 0.25 * x, `旁边的抖动不该让方向偏出去：${x.toFixed(3)},${y.toFixed(3)}`)
  }
  assert.deepEqual(emitted.at(-1), [0, 0], '到了要停下')
})
