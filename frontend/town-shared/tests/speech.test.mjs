// 台词里括起来的动作与神情：切分只影响呈现，世界只认整行字。
// 仓库里没有前端测试运行时，这里像 protocol-wire.test.mjs 一样，把 ts 单独编译一次再导入。
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
    const dir = path.join(root, 'target', 'tmp', 'speech-check')
    fs.mkdirSync(dir, { recursive: true })
    const tsc = path.join(root, 'frontend/town-shared/node_modules/typescript/bin/tsc')
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        path.join(root, 'frontend/town-shared/src/chat/text.ts'),
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
    return import(pathToFileURL(path.join(dir, 'text.js')).href)
  })()
  return loading
}

test('括起来的动作单独成段，说出口的话照旧', async () => {
  const { speechParts } = await load()
  assert.deepEqual(speechParts('（脸颊微红，轻轻挣了一下）讨厌，大庭广众的'), [
    { text: '脸颊微红，轻轻挣了一下', act: true },
    { text: '讨厌，大庭广众的', act: false },
  ])
  // 动作也可以放在句尾，半角括号一样认
  assert.deepEqual(speechParts('好呀（把门带上）'), [
    { text: '好呀', act: false },
    { text: '把门带上', act: true },
  ])
  assert.deepEqual(speechParts('你在看什么'), [{ text: '你在看什么', act: false }])
})

test('空台词与空括号不伪造旁白', async () => {
  const { speechParts } = await load()
  assert.deepEqual(speechParts(''), [])
  assert.deepEqual(speechParts('（ ）'), [])
  // 括号里的空白不单独成段，两侧的话也不留空档
  assert.deepEqual(speechParts('嗯（点头）'), [
    { text: '嗯', act: false },
    { text: '点头', act: true },
  ])
})
