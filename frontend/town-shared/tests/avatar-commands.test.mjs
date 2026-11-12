// 命令状态机回归：长时间后台后重试按钮不能沉默，断线的旧 promise 不能解锁新提交。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let loaded
async function load() {
  if (loaded) return loaded
  loaded = (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'town-avatar-command-'))
    const src = path.join(root, 'frontend/town-shared/src/avatar')
    const transpile = (s) =>
      ts.transpileModule(s, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText
    await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
    const ids = await fs.readFile(path.join(src, '../ids.ts'), 'utf8')
    await fs.writeFile(path.join(dir, 'ids.js'), transpile(ids))
    const commands = await fs.readFile(path.join(src, 'commands.ts'), 'utf8')
    await fs.writeFile(
      path.join(dir, 'commands.js'),
      transpile(commands).replace("from '../ids'", "from './ids.js'")
    )
    return import(pathToFileURL(path.join(dir, 'commands.js')).href)
  })()
  return loaded
}

function harness(createAvatarCommands, deliver = true) {
  globalThis.window ??= globalThis
  const sent = []
  const messages = []
  const commands = createAvatarCommands({
    context: () => ({ online: true, world: 'world', state: { epoch: 'lease' } }),
    nextSequence: () => sent.length + 1,
    stopMoving: () => {},
    showToast: (msg) => messages.push(msg),
    send: (msg) => {
      sent.push(msg)
      return deliver
    },
  })
  return { commands, sent, messages }
}

test('未发出的进入命令立即失败，不会在后台等待 8 秒，能再次点击', async () => {
  const { createAvatarCommands } = await load()
  const h = harness(createAvatarCommands, false)
  assert.equal(
    await h.commands.execute({
      kind: 'enter',
      name: '镇长',
      appearance: { marker: '我', color: '#ffffff' },
    }),
    false
  )
  assert.equal(h.commands.pendingMutation, false)
  assert.match(h.messages.join(' '), /发送失败/)
})

test('尚有进入请求未确认时，第二次点击应明确反馈，不能静默失败', async () => {
  const { createAvatarCommands } = await load()
  const h = harness(createAvatarCommands)
  const first = h.commands.execute({
    kind: 'enter',
    name: '镇长',
    appearance: { marker: '我', color: '#ffffff' },
  })
  assert.equal(h.commands.pendingMutation, true)
  assert.equal(
    await h.commands.execute({
      kind: 'enter',
      name: '镇长',
      appearance: { marker: '我', color: '#ffffff' },
    }),
    false
  )
  assert.equal(h.sent.length, 1)
  assert.match(h.messages.join(' '), /等待回执/)
  h.commands.settle(h.sent[0].request_id, true)
  assert.equal(await first, true)
  assert.equal(h.commands.pendingMutation, false)
})

test('断线清空旧请求后，旧 Promise 不得把新进入请求解锁', async () => {
  const { createAvatarCommands } = await load()
  const h = harness(createAvatarCommands)
  const first = h.commands.execute({
    kind: 'enter',
    name: '镇长',
    appearance: { marker: '我', color: '#ffffff' },
  })
  h.commands.clear()
  const second = h.commands.execute({
    kind: 'enter',
    name: '镇长',
    appearance: { marker: '我', color: '#ffffff' },
  })
  assert.equal(await first, false)
  assert.equal(h.commands.pendingMutation, true, '旧请求 settle 后新请求仍应被锁定')
  h.commands.settle(h.sent[1].request_id, true)
  assert.equal(await second, true)
  assert.equal(h.commands.pendingMutation, false)
})

test('刷新权威状态的 view 可以和一个待确认的进入请求并行', async () => {
  const { createAvatarCommands } = await load()
  const h = harness(createAvatarCommands)
  const entering = h.commands.execute({
    kind: 'enter',
    name: '镇长',
    appearance: { marker: '我', color: '#ffffff' },
  })
  const viewing = h.commands.execute({ kind: 'view' })
  assert.equal(h.sent.length, 2)
  h.commands.settle(h.sent[1].request_id, true)
  assert.equal(await viewing, true)
  assert.equal(h.commands.pendingMutation, true)
  h.commands.settle(h.sent[0].request_id, true)
  assert.equal(await entering, true)
})

test('后台自动 resume 未回执时，主动继续化身优先且旧回执不破坏锁', async () => {
  const { createAvatarCommands } = await load()
  const h = harness(createAvatarCommands)
  const resume = h.commands.execute({ kind: 'resume', token: 'old-token' })
  const entering = h.commands.execute({
    kind: 'enter',
    avatar: 'town-avatar',
    name: '镇长',
    appearance: { marker: '我', color: '#ffffff' },
  })
  assert.equal(h.sent.length, 2, '用户点击应实际发出新的 enter')
  assert.equal(await resume, false, '等待中的自动恢复应让位给主动操作')
  assert.equal(h.commands.pendingMutation, true)
  h.commands.settle(h.sent[0].request_id, false) // 服务端随后才给旧的恢复回执
  assert.equal(h.commands.pendingMutation, true)
  h.commands.settle(h.sent[1].request_id, true)
  assert.equal(await entering, true)
  assert.equal(h.commands.pendingMutation, false)
})
