// 游戏页用到的小镇接口：世界进程没了时重新打开（换新地址接着连），离开时保存并关闭。
import type { MapEntry } from './mapDocument'

/** 自动重开时发现这个小镇是被另一个页面进的小镇挤掉的：不抢回来，由玩家决定回不回来 */
export class TownDisplaced extends Error {}

async function post<T>(id: string, action: string, body: unknown, keepalive = false): Promise<T> {
  const response = await fetch(`/api/towns/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Town-Client': '1' },
    body: JSON.stringify(body),
    keepalive,
  })
  const data = await response.json().catch(() => null)
  if (response.ok) return data as T
  const message = data?.error ?? `小镇服务返回 ${response.status}`
  throw response.status === 409 && action === 'open' ? new TownDisplaced(message) : Error(message)
}

/** 这台电脑上的账号（管理服务的 /api/towns/users）：当前是谁、这个账号固定的那个化身 */
export type HomeAccount = {
  id: string
  name: string
  role: 'admin' | 'member'
  avatar_id: string | null
  avatar_name: string | null
  agent_limit: number | null
  /** 有密码：切换到这个账号要输一次 */
  locked?: boolean
}

export type HomeAccounts = {
  /** 还没建号、没选号时是 null：页面要先去建一个、或者选一个 */
  current: HomeAccount | null
  users: HomeAccount[]
  max: number
  admin: boolean
  /** 第一次打开：还没有管理员，先让玩家自己建一个 */
  needs_setup: boolean
}

/** 还没建号/没选号时接口回的错误码：页面要先把账号那一步摆出来 */
export const ACCOUNT_NEEDED = 'account'

/** 账号接口：读写都用同一套请求头（管理服务只认本机页面发的 JSON） */
async function users<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/towns/users${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Town-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json().catch(() => null)
  if (response.ok) return data as T
  const error = Error(data?.error ?? `小镇服务返回 ${response.status}`)
  if (data?.code) Object.assign(error, { code: data.code })
  throw error
}

/** 账号表；管理服务没有账号接口（老版本）时返回 null，页面按本机单人处理 */
export async function readAccounts(): Promise<HomeAccounts | null> {
  try {
    return await users<HomeAccounts>('')
  } catch {
    return null
  }
}

/** 当前账号；老版本管理服务、或者还没建号/选号时都是 null */
export async function readAccount(): Promise<HomeAccount | null> {
  return (await readAccounts())?.current ?? null
}

/** 第一次打开：用这个名字和密码建管理员，建完就是它 */
export function setupAccount(name: string, pin: string): Promise<unknown> {
  return users('/setup', { name, pin })
}

/** 管理员给朋友建号：给一个初始密码，朋友切过去后可以自己改 */
export function createAccount(name: string, pin: string): Promise<unknown> {
  return users('', { name, pin })
}

/** 切到某个账号（锁着的要密码） */
export function selectAccount(id: string, pin?: string): Promise<unknown> {
  return users('/select', { id, pin })
}

/** 换自己的密码：要验原来的密码 */
export function changePin(current: string, pin: string): Promise<unknown> {
  return users('/pin', { current, pin })
}

/** 记下这个账号的固定化身（传 null 解开）：下次进镇还当同一个人 */
export async function bindAvatar(id: string | null, name = ''): Promise<void> {
  try {
    await users('/avatar', { id, name })
  } catch {
    // 记不住不影响这一局：世界那边已经认出这个化身了，下次按名字接着认
  }
}

/** 常驻小镇此刻的样子（首页的控制按钮显示这些） */
export type ResidentStatus = {
  /** 世界速度：0 是暂停 */
  speed: number
  /** 没开天气的世界是 null */
  weather: { mode: string; kind: string } | null
  /** 世界观设好了没有：没设好的世界推不动速度（世界自己会说「请先设置世界观」） */
  ready: boolean
  /** 这个世界的天气开了没有 */
  climate: boolean
}

/** 让某个小镇留在后台一直跑（管理员），或者取消常驻：取消不会关掉正开着的世界。
 *  ready 说明世界观设好了没有：没设好的小镇先停着，等人进镇设定一次 */
export function keepRunning(id: string, on: boolean): Promise<MapEntry & { ready?: boolean }> {
  return post<MapEntry & { ready?: boolean }>(id, 'resident', { on })
}

/** 首页控制常驻小镇：开始/暂停（speed 0 是暂停）、改天气 */
export function controlTown(
  id: string,
  body:
    | { kind: 'speed'; speed: number }
    | { kind: 'weather'; mode: 'natural' | 'fixed'; weather?: string }
): Promise<{ speed?: number; weather?: { mode: string; kind: string } }> {
  return post(id, 'control', body)
}

/** 重新打开小镇：世界进程不在了，管理服务就从存档把它拉起来。返回新的连接地址和打开凭证。
 *  automatic 是断线后自动重开：被另一个页面进的小镇挤掉时不抢回来，抛 TownDisplaced */
export function reopenTown(id: string, automatic = true) {
  return post<MapEntry>(id, 'open', { automatic })
}

/**
 * 保存并关闭小镇（管理服务的 close 接口）。同时只运行一个小镇，退出就关；
 * keepalive 让关掉网页时发出的这一下也能送到。lease 是打开时拿到的凭证：刷新时旧页面的关闭
 * 可能比新页面的打开晚到，带着凭证，管理服务就知道这一下已经过时，不会关掉新页面刚打开的小镇。
 */
export async function closeTown(id: string, lease?: string, keepalive = false): Promise<void> {
  await post(id, 'close', { lease }, keepalive)
}
