// 游戏页用到的小镇接口：世界进程没了时重新打开（换新地址接着连），离开时保存并关闭。
import type { MapEntry } from './mapDocument'
import type { TemplateFields } from './protocol'

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
  /** 能不能附身村民：管理员本来就可以，普通账号由管理员在账号页放开（D.46） */
  possess?: boolean
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

/** 管理员放开/收回某个账号的「附身村民」：世界按票上的标记放行（D.46） */
export function setPossess(id: string, allowed: boolean): Promise<unknown> {
  return users('/possess', { id, allowed })
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

/**
 * 账号自己养的村民（agent）：定义跟着账号走，换小镇还能用；投进哪个小镇是一次手动动作，
 * 投进去之后那一段记忆只留在那个小镇的存档里。
 */
export type HomeAgent = {
  id: string
  name: string
  /** 老形状才有：指向某个镇村民库里的模板。新定义改用 fields */
  template_id: string
  template_version: number
  /** 整份人设与长相：投放时由管理服务写进那个镇的村民库 */
  fields?: TemplateFields
  /** 人设改过几版：投放时据此判断要不要重写镇上的模板 */
  revision: number
  home?: string
  created_at: string
  /** 已经住进哪些小镇：换镇不搬人，是在另一个镇再住一份 */
  deployed: { town: string; resident: string; name: string; at: string }[]
}

export type HomeAgents = {
  agents: HomeAgent[]
  /** 这个账号最多能建几个：null 是不限（管理员） */
  limit: number | null
}

/** 建 agent 时选一个镇上可用的村民模板 */
export type AgentTemplate = {
  template_id: string
  version: number
  name: string
  intro: string
  tags: string[]
}

/** 账号接口在 /api/towns 下（不是 /api/towns/<镇>/…），单独一个助手 */
async function home<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/towns${path}`, {
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

/** 这个账号的 agent 们；管理服务没有这个接口（老版本）时返回 null，首页就不摆这一块 */
export async function readAgents(): Promise<HomeAgents | null> {
  try {
    return await home<HomeAgents>('/agents')
  } catch {
    return null
  }
}

/** 建一个 agent：整份人设（在首页用建村民的界面做的），投进哪个镇另说 */
export function makeAgent(body: {
  fields: TemplateFields
  home?: string
}): Promise<{ ok: true; agent: HomeAgent }> {
  return home('/agents', body)
}

/** 改一份定义：已经投出去的那位不会跟着变，收回再投才更新 */
export function updateAgent(
  id: string,
  body: { fields: TemplateFields; home?: string }
): Promise<{ ok: true; agent: HomeAgent }> {
  return home('/agents/update', { id, ...body })
}

/** 按当前字段渲染人设全文：世界那边的纯函数，小镇得先跑起来 */
export function previewPersona(
  townId: string,
  fields: TemplateFields
): Promise<{ persona: string; error: string | null }> {
  return post(townId, 'persona', { fields })
}

/** 用小镇的工具模型按一句话描述生成一整份人设 */
export function generateVillager(
  townId: string,
  brief: string
): Promise<{ ok: boolean; message: string; fields: TemplateFields | null }> {
  return post(townId, 'generate', { brief })
}

/** 删掉一个还没投出去的 agent（还在镇里的删不掉） */
export function deleteAgent(id: string): Promise<{ ok: true }> {
  return home('/agents/delete', { id })
}

/** 账号自己的每日额度：限定投出去的 agent 每天最多用多少；空着的那项用小镇自己的上限 */
export type AccountBudget = {
  calls_per_day?: number
  tokens_per_day?: number
  /** 这个账号投出去的居民同时在途的上限（同账号共用） */
  max_concurrent?: number
  /** 这个账号的居民每分钟最多发几次模型请求（同账号共用） */
  per_minute?: number
}

/** 投出去的某一位今天用了多少（世界按居民记，管理服务换回账号的 agent） */
export type AccountUsageRow = {
  agent_id: string
  name: string
  town: string
  town_name: string
  /** 那个小镇此刻在不在运行：没在跑就记 0（不是「没花」，是「不知道」） */
  running: boolean
  resident: string
  resident_name: string
  calls: number
  tokens: number
  input_tokens: number
  cache_hit_tokens: number
  replies: number
  in_flight: number
  paused: unknown
  /** 服务商没回计量的次数：花费不明 */
  unmetered: number
  /** 今天这位花掉的钱（微元 = 元 × 1 000 000）：只算价目表里有的模型 */
  cost_micros: number
}

/** 账本里某一天的用量：`tokens` 只算服务商报回来的，没报的几次在 `unmetered`（估算值在 `estimated`） */
export type AccountUsageDay = {
  day: string
  calls: number
  tokens: number
  input_tokens: number
  cache_hit_tokens: number
  unmetered: number
  estimated: number
  /** 花掉的钱（微元）；`priced` 是算进去了的请求数，`unpriced` 是有计量没价钱的 */
  cost_micros: number
  priced: number
  unpriced: number
  agents: {
    agent_id: string
    name: string
    calls: number
    tokens: number
    unmetered: number
    cost_micros: number
  }[]
}

export type AccountUsage = {
  budget: AccountBudget
  totals: {
    calls: number
    tokens: number
    unmetered: number
    /** 今天花掉的钱（微元 = 元 × 1 000 000） */
    cost_micros: number
    /** 算进去了的请求数 / 有计量但价目表里没这个模型的请求数 */
    priced: number
    unpriced: number
  }
  agents: AccountUsageRow[]
  /** 最近几天（新的在前）：跨天留着，小镇换天归零也不会丢 */
  history: AccountUsageDay[]
}

/** 这个账号今天用了多少；管理服务没有这个接口（老版本）时返回 null */
export async function readUsage(): Promise<AccountUsage | null> {
  try {
    return await home<AccountUsage>('/usage')
  } catch {
    return null
  }
}

/** 存额度：两项都可以不带（= 回到小镇自己的上限），顺手发给正在跑的小镇 */
export function saveBudget(
  body: AccountBudget
): Promise<{ ok: true; budget: AccountBudget; notes: string[] }> {
  return home('/budget', body)
}

/** 某个小镇现在能用的村民模板：小镇没在运行时拿不到 */
export async function readTemplates(id: string): Promise<AgentTemplate[]> {
  const response = await fetch(`/api/towns/${encodeURIComponent(id)}/templates`, {
    headers: { 'X-Town-Client': '1' },
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw Error(data?.error ?? `小镇服务返回 ${response.status}`)
  return (data as { templates: AgentTemplate[] }).templates
}

/** 把 agent 投进某个小镇：镇上多一个居民，这段记忆留在这个镇的存档里 */
export function deployAgent(
  id: string,
  agentId: string
): Promise<{ ok: true; agent: HomeAgent; note?: string }> {
  return post(id, 'deploy', { agent_id: agentId })
}

/** 请投放出去的那一位离开某个小镇：镇上少一个人，这段记忆留在那个镇的存档里 */
export function withdrawAgent(
  id: string,
  agentId: string
): Promise<{ ok: true; agent: HomeAgent; message?: string }> {
  return post(id, 'withdraw', { agent_id: agentId })
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
