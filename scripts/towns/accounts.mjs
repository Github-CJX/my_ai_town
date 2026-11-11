// 这台电脑上的账号：默认管理员、管理员给朋友建的普通账号。每个账号一份自己的模型密钥
// （普通账号从空开始，各填各的；管理员那份就是小镇的公共密钥）。手机上的管理服务
// （crates/manager/src/accounts.rs）按同样的规则存同一个 accounts.json。
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError, Raw } from './http.mjs'
import { atomicJson, readJson } from './storage.mjs'
export const USER_COOKIE = 'town_user'
export const MAX_USERS = 8
const MAX_NAME = 16
const hex = (bytes) => randomBytes(bytes).toString('hex')

export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    avatar_id: user.avatar_id ?? null,
    avatar_name: user.avatar_name ?? null,
    agent_limit: user.agent_limit ?? null,
    created_at: user.created_at,
  }
}

/** 请求 Cookie 里的账号编号；没有或格式不对时为 null（当游客，按默认管理员算） */
export function cookieId(headers) {
  for (const part of String(headers?.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === USER_COOKIE) return part.slice(at + 1).trim() || null
  }
  return null
}

export function accountCookie(id) {
  return `${USER_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`
}

export class Accounts {
  #users = []
  constructor(root) {
    this.root = root
  }
  file() {
    return path.join(this.root, 'accounts.json')
  }
  /** 读账号表；没有管理员（第一次启动、文件被删）就建一个默认管理员并落盘。 */
  async load() {
    try {
      const saved = await readJson(this.file())
      if (Array.isArray(saved?.users))
        this.#users = saved.users.filter((u) => u && typeof u.id === 'string')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    if (!this.#users.some((u) => u.role === 'admin')) {
      this.#users.unshift(makeUser('管理员', 'admin', null))
      await this.save()
    }
    return this
  }
  async save() {
    await atomicJson(this.file(), { version: 1, users: this.#users })
  }
  list() {
    return this.#users
  }
  find(id) {
    return id ? this.#users.find((u) => u.id === id) : undefined
  }
  admin() {
    return this.#users.find((u) => u.role === 'admin')
  }
  /** 这个 Cookie 对应的账号；找不到（或没带）就是默认管理员 */
  current(id) {
    return this.find(id) ?? this.admin()
  }
  /** 建一个普通账号：名字 1–16 字、不重名，最多 MAX_USERS 个。 */
  async create(name) {
    const clean = String(name ?? '').trim()
    if (!clean || clean.length > MAX_NAME) throw new HttpError(400, `名字须为 1–${MAX_NAME} 个字符`)
    if (/[\u0000-\u001f\u007f]/.test(clean)) throw new HttpError(400, '名字里有不能用的字符')
    if (this.#users.some((u) => u.name === clean)) throw new HttpError(400, '已经有同名账号了')
    if (this.#users.length >= MAX_USERS) throw new HttpError(400, `最多 ${MAX_USERS} 个账号`)
    const user = makeUser(clean, 'member', 1)
    this.#users.push(user)
    await this.save()
    return user
  }
  /**
   * 记下这个账号在小镇里的固定化身（页面上第一次进化身、改名之后各记一次）；传 null 解开。
   * 编号和名字都由页面上报：本机形态没有口令，这一条是「一个账号一个化身」的记性，不是授权。
   */
  async setAvatar(id, avatar) {
    const user = this.find(id)
    if (!user) throw new HttpError(400, '没有这个账号')
    if (avatar) {
      const badge =
        typeof avatar.id !== 'string' ||
        !avatar.id ||
        avatar.id.length > 64 ||
        /[\s\u0000-\u001f\u007f]/.test(avatar.id)
      if (badge) throw new HttpError(400, '化身编号不合法')
      if (String(avatar.name ?? '').length > MAX_NAME)
        throw new HttpError(400, `化身名字最多 ${MAX_NAME} 个字`)
    }
    user.avatar_id = avatar ? avatar.id : null
    user.avatar_name = avatar ? String(avatar.name ?? '') : null
    await this.save()
    return user
  }
  /**
   * 这个账号要用的应用配置：管理员直接用小镇公共那份；普通账号各有一份，只把
   * providers_path / credentials_path 换到自己目录下（密钥从空开始，模板等仍然共享）。
   */
  async config(base, user) {
    const app = await readJson(base)
    if (!user || user.role === 'admin') return base
    const dir = path.join(this.root, 'users', user.id),
      config = path.join(dir, 'application.json')
    const dest = (field) => path.join(dir, 'config', path.basename(app[field]))
    for (const field of ['providers_path', 'credentials_path']) {
      const file = dest(field)
      let exists = true
      try {
        await fs.access(file)
      } catch {
        exists = false
      }
      if (!exists) {
        let value = {}
        if (field === 'providers_path')
          try {
            value = await readJson(app[field])
          } catch {}
        await atomicJson(file, value)
      }
      app[field] = file
    }
    await atomicJson(config, app)
    return config
  }
}

function makeUser(name, role, agent_limit) {
  return {
    id: 'u' + hex(8),
    name,
    role,
    avatar_id: null,
    avatar_name: null,
    agent_limit,
    created_at: Math.floor(Date.now() / 1000),
  }
}

/**
 * 账号接口：当前是谁、管理员建号、切换前端档案。手机上的管理服务（crates/manager/src/routes.rs
 * 的 accounts_api）路径与回答一致。
 */
export function createAccountRoutes({ accounts }) {
  return [
    [
      'GET',
      /^\/api\/towns\/users$/,
      ({ headers }) => {
        const me = accounts.current(cookieId(headers))
        return {
          current: publicUser(me),
          users: accounts.list().map(publicUser),
          max: MAX_USERS,
          admin: me.role === 'admin',
        }
      },
    ],
    [
      'POST',
      /^\/api\/towns\/users$/,
      async ({ body, headers }) => {
        if (accounts.current(cookieId(headers)).role !== 'admin')
          throw new HttpError(403, '只有管理员可以创建账号')
        // 建完仍留在管理员这边：朋友在这台电脑上自己选进他的档案
        return { ok: true, user: publicUser(await accounts.create(body?.name)) }
      },
    ],
    [
      'POST',
      /^\/api\/towns\/users\/select$/,
      ({ body, headers }) => {
        const id = typeof body?.id === 'string' ? body.id : null
        let user
        if (id) {
          user = accounts.find(id)
          if (!user) throw new HttpError(404, '没有这个账号')
        } else user = accounts.current(cookieId(headers))
        return new Raw(JSON.stringify({ ok: true, current: publicUser(user) }), {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': accountCookie(user.id),
        })
      },
    ],
    [
      'POST',
      /^\/api\/towns\/users\/avatar$/,
      async ({ body, headers }) => {
        const me = accounts.current(cookieId(headers))
        const id = typeof body?.id === 'string' ? body.id : null
        const avatar = id ? { id, name: typeof body?.name === 'string' ? body.name : '' } : null
        return { ok: true, current: publicUser(await accounts.setAvatar(me.id, avatar)) }
      },
    ],
  ]
}
