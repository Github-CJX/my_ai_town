// 放到服务器上：只能通过 IP 和端口访问。页面与接口都按请求自己的地址拼，别的域名不许用。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createManager } from '../town-manager.mjs'
import { signIn } from './support.mjs'

/** 用指定的 Host 头发一次请求：远程访问时 Host 是页面与接口唯一的地址来源 */
function ask(port, host, route, { method = 'GET', cookie, body, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          host,
          ...(cookie ? { cookie } : {}),
          ...(extra ?? {}),
          ...(data ? { 'content-type': 'application/json', 'x-town-client': '1' } : {}),
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode, json, text })
        })
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

/** 先找一个现在空着的端口：给「直接暴露世界端口」的老办法留一个固定的位置 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

test('对外的管理服务认 IP，世界地址也按访问用的地址拼', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-remote-'))
  let m
  try {
    const worldPort = await freePort()
    m = await createManager({ root, port: 0, mockLlm: true, bind: '0.0.0.0', hostPort: worldPort })
    const port = m.server.address().port
    const cookie = await signIn(`http://127.0.0.1:${port}/api/towns`)
    // 本机照旧
    const local = await ask(port, `127.0.0.1:${port}`, '/api/towns', { cookie })
    assert.equal(local.status, 200, local.text)
    // 别的机器用这台机器的 IP 访问
    const remote = await ask(port, `192.0.2.10:${port}`, '/api/towns', { cookie })
    assert.equal(remote.status, 200, remote.text)
    const town = remote.json.towns.find((t) => t.available)
    assert.ok(town, '没有可用的小镇')
    const opened = await ask(port, `192.0.2.10:${port}`, `/api/towns/${town.id}/open`, {
      method: 'POST',
      cookie,
      body: {},
    })
    assert.equal(opened.status, 200, opened.text)
    // 世界连接也走管理服务这一个端口：主机换成页面访问用的地址，路径是 /ws/<镇>，不再带世界端口
    assert.match(
      opened.json.endpoint,
      new RegExp(`^ws://192\\.0\\.2\\.10:${port}/ws/${town.id}\\?session=`)
    )
    // 别人的域名解析到这台机器上也不行
    const stranger = await ask(port, 'town.example.com', '/api/towns', { cookie })
    assert.equal(stranger.status, 403)
    assert.match(stranger.json.error, /仅提供本机服务/)
  } finally {
    await m?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('只在本机用时，外部的地址一律不认', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-local-'))
  let m
  try {
    m = await createManager({ root, port: 0, mockLlm: true, bind: '127.0.0.1' })
    const port = m.server.address().port
    const cookie = await signIn(`http://127.0.0.1:${port}/api/towns`)
    const local = await ask(port, `127.0.0.1:${port}`, '/api/towns', { cookie })
    assert.equal(local.status, 200, local.text)
    const remote = await ask(port, `192.0.2.10:${port}`, '/api/towns', { cookie })
    assert.equal(remote.status, 403)
  } finally {
    await m?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('套反代只开一个端口：页面的世界连接也从这一个端口转进去', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'town-proxy-'))
  let m
  try {
    // 反代在本机，管理服务只听得见 127.0.0.1；页面那边看到的是公开域名
    m = await createManager({ root, port: 0, mockLlm: true })
    const port = m.server.address().port
    const cookie = await signIn(`http://127.0.0.1:${port}/api/towns`)
    const host = 'town.example.com'
    const proxied = { 'x-forwarded-proto': 'https', 'x-forwarded-host': host }
    const list = await ask(port, host, '/api/towns', { cookie, headers: proxied })
    assert.equal(list.status, 200, list.text)
    const town = list.json.towns.find((t) => t.available)
    assert.ok(town, '没有可用的小镇')
    const opened = await ask(port, host, `/api/towns/${town.id}/open`, {
      method: 'POST',
      cookie,
      body: {},
      headers: proxied,
    })
    assert.equal(opened.status, 200, opened.text)
    // 页面拿到的世界地址：同一个域名、同一个端口，不带世界端口，走 /ws/<镇>
    const url = new URL(opened.json.endpoint)
    assert.equal(url.protocol, 'wss:')
    assert.equal(url.host, host)
    assert.equal(url.pathname, `/ws/${town.id}`)
    assert.ok(url.searchParams.get('session'), '世界口令丢了')
    assert.ok(url.searchParams.get('ticket'), '入场票丢了')
    // 沿着同一个端口连进去（这里用回环直连模拟反代）：管理服务把连接转给世界，
    // 先收到世界的自报家门，接着就不断有名册推过来
    const local = `ws://127.0.0.1:${port}/ws/${town.id}?${url.searchParams.toString()}`
    const seen = await new Promise((resolve, reject) => {
      const ws = new WebSocket(local)
      const seen = []
      const timer = setTimeout(() => {
        ws.close()
        reject(Error(`转进去的连接只收到 ${JSON.stringify(seen)}`))
      }, 8000)
      ws.addEventListener('message', (e) => {
        seen.push(String(e.data))
        if (seen.some((m) => m.includes('"type":"roster"'))) {
          clearTimeout(timer)
          ws.close()
          resolve(seen)
        }
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(Error('连不上世界'))
      })
    })
    assert.match(seen[0], /"type":"world_identity"/)
  } finally {
    await m?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
