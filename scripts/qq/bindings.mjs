//! QQ 号 ↔ 小镇账号 ↔ 一位村民 的绑定表。
//!
//! 一个 QQ 号只代表一位村民，一位村民也只接一个 QQ 号：机器人对外只有一个昵称，
//! 两副面孔会让人分不清在跟谁说话。所以这张表既是「谁是谁」，也是唯一性约束。
//!
//! 文件在 `config/qq-bindings.json`（600 权限，不进仓库）。`cursor` 是这位主人自己的
//! 事件游标：每人一份事件流水，不能拿别人的编号去比。

import { readFile } from 'node:fs/promises'
import { atomicJson } from '../towns/storage.mjs'

export const VERSION = 1

export const EMPTY = { version: VERSION, bindings: [] }

const FIELDS = ['openid', 'account', 'town', 'resident']

/** 读绑定表；还没绑过就是空的，不是错误。 */
export async function readBindings(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...EMPTY, bindings: [] }
    throw error
  }
  return parseBindings(JSON.parse(raw))
}

export function parseBindings(raw) {
  const list = Array.isArray(raw?.bindings) ? raw.bindings : []
  const bindings = list.map((item) => {
    const entry = {}
    for (const key of FIELDS) {
      const value = String(item?.[key] ?? '').trim()
      if (!value) throw Error(`绑定表里有一条少了 ${key}`)
      entry[key] = value
    }
    entry.resident_name = String(item?.resident_name ?? '').trim()
    entry.cursor = Math.max(0, Number(item?.cursor) || 0)
    entry.since = String(item?.since ?? '').trim()
    return entry
  })
  return { version: VERSION, bindings }
}

/** 写绑定表：原子替换，只有主人自己能读。 */
export async function saveBindings(file, data) {
  await atomicJson(file, { version: VERSION, bindings: data.bindings ?? [] }, 0o600)
}

/** 这个 QQ 号代表哪位村民。 */
export function findByOpenid(data, openid) {
  const id = String(openid ?? '').trim()
  if (!id) return null
  return data.bindings.find((item) => item.openid === id) ?? null
}

/** 这位村民绑给了哪个 QQ 号。 */
export function findByResident(data, resident) {
  const id = String(resident ?? '').trim()
  if (!id) return null
  return data.bindings.find((item) => item.resident === id) ?? null
}

/**
 * 加一条绑定（或改掉同一个人身上原有的那条）。
 *
 * 一处冲突就整条拒绝：让上层把「这个 QQ 已经代表别人了」「这位村民已经有主人了」原样说给用户。
 */
export function bind(data, entry, { now = () => new Date() } = {}) {
  const next = { ...entry }
  for (const key of FIELDS) next[key] = String(entry?.[key] ?? '').trim()
  for (const key of FIELDS) if (!next[key]) throw Error(`绑定要写清楚 ${key}`)
  next.resident_name = String(entry.resident_name ?? '').trim()
  next.since = String(entry.since ?? '').trim() || now().toISOString()
  next.cursor = Math.max(0, Number(entry.cursor) || 0)
  const byOpenid = findByOpenid(data, next.openid)
  if (byOpenid && byOpenid.resident !== next.resident)
    throw Error(`这个 QQ 已经在替「${byOpenid.resident_name || byOpenid.resident}」收信了`)
  const byResident = findByResident(data, next.resident)
  if (byResident && byResident.openid !== next.openid)
    throw Error(`「${next.resident_name || next.resident}」已经绑了别的 QQ`)
  const others = data.bindings.filter(
    (item) => item.openid !== next.openid && item.resident !== next.resident
  )
  // 同一个 QQ 与同一位村民重绑：保留原来的游标，别把没读过的信又读一遍。
  const cursor = Math.max(next.cursor, byOpenid?.cursor ?? 0, byResident?.cursor ?? 0)
  return { version: VERSION, bindings: [...others, { ...next, cursor }] }
}

/** 解绑：按 QQ 号或村民编号都行。 */
export function unbind(data, { openid, resident }) {
  const bindings = data.bindings.filter(
    (item) =>
      (!openid || item.openid !== String(openid).trim()) &&
      (!resident || item.resident !== String(resident).trim())
  )
  return { version: VERSION, bindings }
}

/** 记下游标：读到第几件事了。只改这一条。 */
export function setCursor(data, openid, cursor) {
  const id = String(openid ?? '').trim()
  const at = Math.max(0, Number(cursor) || 0)
  return {
    version: VERSION,
    bindings: data.bindings.map((item) =>
      item.openid === id ? { ...item, cursor: Math.max(item.cursor, at) } : item
    ),
  }
}
