// 玩家反过来主动提亲近：世界早收这种邀请，缺的一直是页面这一边。
// 和 speech.test.mjs 一样，把 ts 单独编译一次再导入（仓库里没有前端测试运行时）。
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
    const dir = path.join(root, 'target', 'tmp', 'close-check')
    fs.mkdirSync(dir, { recursive: true })
    const tsc = path.join(root, 'frontend/town-shared/node_modules/typescript/bin/tsc')
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        path.join(root, 'frontend/town-shared/src/avatar/close.ts'),
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
    return import(pathToFileURL(path.join(dir, 'close.js')).href)
  })()
  return loading
}

test('三种亲近各有自己的说法，按牵、靠、抱的顺序摆', async () => {
  const { TOUCH_OFFERS } = await load()
  assert.deepEqual(
    TOUCH_OFFERS.map((o) => o.gesture),
    ['hold_hands', 'lean', 'hug']
  )
  for (const offer of TOUCH_OFFERS) {
    assert.ok(offer.label.length > 0, '按钮上要有字')
    assert.ok(offer.message.endsWith('？'), '邀请卡上带一句话')
  }
})

test('发出去的邀请就是世界认的那条命令', async () => {
  const { TOUCH_OFFERS, touchOffer } = await load()
  for (const offer of TOUCH_OFFERS) {
    assert.deepEqual(touchOffer('r1', offer.gesture), {
      operation: 'offer',
      partner_id: 'r1',
      interaction: { kind: 'touch', gesture: offer.gesture },
      message: offer.message,
    })
  }
})
