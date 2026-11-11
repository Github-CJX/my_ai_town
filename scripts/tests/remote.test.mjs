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
function ask(port, host, route, { method = 'GET', cookie, body } = {}) {
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

/** 先找一个现在空着的端口：世界固定端口后，防火墙上只开这一个就够 */
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
    // 世界自己的端口是管理员定下的那个：主机换成页面访问用的地址，远程浏览器才连得上
    assert.match(
      opened.json.endpoint,
      new RegExp(`^ws://192\\.0\\.2\\.10:${worldPort}/\\?session=`)
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
