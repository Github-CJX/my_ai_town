// 测试共用：仓库根目录、生成素材、Rust 校验入口。不依赖 cwd。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { generate } from '../mapgen/generate.mjs'
export const root = fileURLToPath(new URL('../../', import.meta.url))
export const read = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'))
export const library = read('data/mapgen/templates.json')
export const contours = read('data/mapgen/contours.json')
export const definitions = read('data/props/core/definitions.json')
export const gen = (spec, options) => generate(spec, library, contours, definitions, options)
// 用 Rust 的 town-map validate 校验一份地图，返回子进程结果。
export function townMap(document) {
  return spawnSync(path.join(root, 'target/debug/town-map'), ['validate'], {
    input: JSON.stringify(document),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  })
}
export function gate(document) {
  const r = townMap(document)
  assert.ifError(r.error)
  assert.equal(r.status, 0, r.stdout + r.stderr)
}
export function rejected(document) {
  const r = townMap(document)
  assert.notEqual(r.status, 0, r.stdout)
  return r.stdout
}
/** 第一次打开要先自己建管理员：测试里统一建一个，返回账号 Cookie 段 */
export async function signIn(base) {
  const r = await fetch(`${base}/users/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-town-client': '1' },
    body: JSON.stringify({ name: '测试管理员', pin: '1234' }),
  })
  if (!r.ok) throw Error((await r.json()).error)
  return r.headers.get('set-cookie').split(';')[0]
}
/** 用正常 PIN 登录，拿到不透明的账号会话 Cookie。 */
export async function userSession(base, id, pin) {
  const r = await fetch(`${base}/users/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-town-client': '1' },
    body: JSON.stringify({ id, pin }),
  })
  if (!r.ok) throw Error((await r.json()).error)
  return r.headers.get('set-cookie').split(';')[0]
}
/** 以某个账号的身份请求管理服务：base 形如 http://127.0.0.1:PORT/api/towns */
export function client(base, cookie) {
  return async (route, body) => {
    const r = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-town-client': '1' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await r.json()
    if (!r.ok) throw Error(data.error)
    return data
  }
}
