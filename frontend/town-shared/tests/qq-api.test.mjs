// QQ 绑定接口的地址：`/api/qq/…`，不是 `/api/towns/qq/…`。
// 这条测试存在的原因：网页上的「绑定 QQ」弹框一开始就是空下拉框——前端把账号接口那个
// `/api/towns` 前缀套在 QQ 接口上，四个绑定接口全部 404，而 `readQqBindings()` 又把 404
// 吞成 null，界面上只看到「空、没有一行」，看不出是路径错了。所以这里把每条请求的
// URL 与 body 都钉住，并且要求 401 这类错误照抛（不能再悄悄变成「没有接口」）。
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
    const dir = path.join(root, 'target', 'tmp', 'qq-api-check')
    fs.mkdirSync(dir, { recursive: true })
    const tsc = path.join(root, 'frontend/town-shared/node_modules/typescript/bin/tsc')
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        path.join(root, 'frontend/town-shared/src/townApi.ts'),
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
      .filter((line) => line.includes('townApi.ts') && line.includes('error TS'))
    assert.deepEqual(own, [], output)
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
    return await import(pathToFileURL(path.join(dir, 'townApi.js')).href)
  })()
  return loading
}

/** 记下每一次请求；按 `reply` 给响应（默认空 JSON 200） */
function wire(reply = () => ({ ok: true, status: 200, body: {} })) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    const { ok, status, body } = reply(call)
    return {
      ok,
      status,
      json: async () => body,
    }
  }
  return calls
}

test('读绑定打 /api/qq/binding：带上客户端标记，不带 /api/towns 前缀', async () => {
  const api = await load()
  const calls = wire()
  await api.readQqBindings()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/qq/binding')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers['X-Town-Client'], '1')
})

test('绑上、解开都打 /api/qq：body 原样带上 agent 与认领号', async () => {
  const api = await load()
  const calls = wire()
  await api.bindQq({ agent: 'a1', pending: 'qabc', town: 'default-town' })
  await api.bindQq({ agent: 'a1', openid: 'ABCD1234EFGH' })
  await api.unbindQq({ agent: 'a1', town: 'default-town' })
  assert.deepEqual(
    calls.map((call) => [call.method, call.url]),
    [
      ['POST', '/api/qq/binding'],
      ['POST', '/api/qq/binding'],
      ['POST', '/api/qq/unbind'],
    ]
  )
  assert.deepEqual(calls[0].body, { agent: 'a1', pending: 'qabc', town: 'default-town' })
  assert.deepEqual(calls[1].body, { agent: 'a1', openid: 'ABCD1234EFGH' })
  assert.deepEqual(calls[2].body, { agent: 'a1', town: 'default-town' })
})

test('老版本管理服务没有这块接口（404）才算没装，返回 null', async () => {
  const api = await load()
  wire(() => ({ ok: false, status: 404, body: { error: '操作不存在' } }))
  assert.equal(await api.readQqBindings(), null)
})

test('没登录（401 account）要照抛：别把「该重新登录」画成「没有接口」', async () => {
  const api = await load()
  wire(() => ({ ok: false, status: 401, body: { error: '请先登录', code: 'account' } }))
  await assert.rejects(api.readQqBindings(), (error) => {
    assert.equal(error.message, '请先登录')
    assert.equal(error.status, 401)
    assert.equal(error.code, 'account')
    return true
  })
})

test('绑不上（409）把服务端那句话原样交给界面', async () => {
  const api = await load()
  wire(() => ({ ok: false, status: 409, body: { error: '这个 QQ 已经在替「大肥鱼」收信了' } }))
  await assert.rejects(api.bindQq({ agent: 'a1', openid: 'ABCD1234EFGH' }), {
    message: '这个 QQ 已经在替「大肥鱼」收信了',
  })
})
