// 摆放格子的算术：格号、格心、吸附到能放的格子。
// 仓库里没有前端测试运行时，这里像 speech.test.mjs 一样，把 ts 单独编译一次再导入。
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
    const dir = path.join(root, 'target', 'tmp', 'grid-check')
    fs.mkdirSync(dir, { recursive: true })
    const tsc = path.join(root, 'frontend/town-shared/node_modules/typescript/bin/tsc')
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        path.join(root, 'frontend/town-shared/src/props/grid.ts'),
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
    // 编译产物在仓库根的 target/ 下，没有 package.json 就会被当成 CommonJS。
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
    return import(pathToFileURL(path.join(dir, 'grid.js')).href)
  })()
  return loading
}

/** 三列两行、一格一米、第一格中心在 (0.5, 0.5)：. 能放，p 碰到东西 */
const grid = () => ({
  origin: [0.5, 0.5],
  columns: 3,
  rows: 2,
  step: 1,
  cells: '..p' + '.pp',
})

test('点的位置落在哪个格、格心在哪', async () => {
  const { cellIndex, cellCenter } = await load()
  const g = grid()
  assert.equal(cellIndex(g, [0.5, 0.5]), 0)
  assert.equal(cellIndex(g, [1.6, 0.7]), 1)
  assert.equal(cellIndex(g, [2.4, 1.5]), 5)
  // 点在格子范围外：不猜
  assert.equal(cellIndex(g, [0.5, -1.5]), null)
  assert.equal(cellIndex(g, [4.5, 0.5]), null)
  assert.deepEqual(cellCenter(g, 0), [0.5, 0.5])
  assert.deepEqual(cellCenter(g, 4), [1.5, 1.5])
  assert.equal(cellCenter(g, 6), null)
  assert.equal(cellCenter(g, -1), null)
  // 格距为 0 的坏数据不除零
  assert.equal(cellIndex({ ...g, step: 0 }, [1, 1]), null)
})

test('只有能放的格才吸附，吸不上就交给最近的空格', async () => {
  const { snapToCell, nearestFree } = await load()
  const g = grid()
  // 能放的格：吸到格心
  assert.deepEqual(snapToCell(g, [0.6, 0.4]), [0.5, 0.5])
  // 碰着东西的格：不吸（免得点哪放哪都落在障碍上）
  assert.equal(snapToCell(g, [2.5, 0.5]), null)
  // 往外找最近的空格：第二行最右一格不能放，斜上一格 (1.5, 0.5) 只有一个格远
  assert.deepEqual(nearestFree(g, [2.5, 1.5]), [1.5, 0.5])
  // 就在空心上也回同一格
  assert.deepEqual(nearestFree(g, [1.4, 0.6], 0), [1.5, 0.5])
  // limit 太小时不跨出去找
  assert.equal(nearestFree(g, [2.5, 0.5], 0), null)
})
