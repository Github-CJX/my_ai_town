// 账号自己的用量与额度：世界按居民记用量，管理服务把居民换回账号的 agent 再汇总
// （crates/manager/src/usage.rs 的同一份规则）。额度住在账号目录的 budget.json 里，
// 限定这个账号投出去的每位居民每天的调用数与 token 数，由世界按居民执行（set_resident_budget）。
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { HttpError } from './http.mjs'
import { listAgents } from './agents.mjs'
import { atomicJson, readJson, safeId } from './storage.mjs'

const hex = (bytes) => randomBytes(bytes).toString('hex')

/** 账号自己的每日额度存这里；两项都空 = 各用世界的全镇额度。 */
export const budgetFile = (root, userId) => path.join(root, 'users', safeId(userId), 'budget.json')

export function hasBudget(budget) {
  return budget?.calls_per_day != null || budget?.tokens_per_day != null
}

/** 读账号的额度；文件不在或读坏了就当没设过（全员用世界的全镇额度）。 */
export async function readBudget(root, userId) {
  let doc = {}
  try {
    doc = await readJson(budgetFile(root, userId))
  } catch {
    return {}
  }
  const budget = {}
  if (Number.isInteger(doc?.calls_per_day) && doc.calls_per_day > 0)
    budget.calls_per_day = doc.calls_per_day
  if (Number.isInteger(doc?.tokens_per_day) && doc.tokens_per_day > 0)
    budget.tokens_per_day = doc.tokens_per_day
  return budget
}

function number(body, key) {
  const value = body?.[key]
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0) throw new HttpError(400, `${key} 须是不小于 0 的整数`)
  return value
}

/** 存下来。两项都可以不带（= 回到全镇额度），但给了就不能是 0。 */
export async function saveBudget(root, userId, body) {
  const calls = number(body, 'calls_per_day')
  const tokens = number(body, 'tokens_per_day')
  if (calls === 0) throw new HttpError(400, '每日调用上限须大于 0')
  if (tokens === 0) throw new HttpError(400, '每日 token 上限须大于 0')
  const budget = {}
  if (calls !== null) budget.calls_per_day = calls
  if (tokens !== null) budget.tokens_per_day = tokens
  await atomicJson(budgetFile(root, userId), budget)
  return budget
}

/**
 * 把账号的额度发给正在跑的小镇：一位居民发一条，世界按居民执行。
 * 没在跑的小镇跳过——等它下次起来，投放/心跳会再发一次。
 */
export async function pushBudget(hosts, town, agents, budget) {
  if (!hosts.isRunning(town)) return
  for (const agent of agents) {
    const record = agent.deployed?.[town]
    if (!record) continue
    const requestId = `budget-${agent.id}-${hex(8)}`
    const command = {
      type: 'set_resident_budget',
      request_id: requestId,
      resident: record.resident,
    }
    if (budget.calls_per_day != null) command.calls_per_day = budget.calls_per_day
    if (budget.tokens_per_day != null) command.tokens_per_day = budget.tokens_per_day
    const reply = await hosts.query(
      town,
      command,
      (m) => m.type === 'resident_budget_saved' && m.request_id === requestId
    )
    if (reply.ok !== true) throw new HttpError(409, reply.message ?? '镇上没接受这个额度，稍后再试')
  }
}

/** 提示里用的小镇名字：读不到就退回编号 */
export const townName = async (storage, id) => {
  try {
    const { name } = await storage.labels(id, await storage.map(id))
    return name || id
  } catch {
    return id
  }
}

const number_of = (value) => (Number.isInteger(value) ? value : 0)

/** 账号的跨天账本存这里：逐日逐人，请求号去重（世界那边的台账只留最近若干条，日计数过一天就归零）。 */
export const ledgerFile = (root, userId) => path.join(root, 'users', safeId(userId), 'usage.json')

const nowSecs = () => Math.floor(Date.now() / 1000)

/** Unix 秒 → UTC 日期 `YYYY-MM-DD`（和 Rust 那边同一套算法）。 */
const dayOf = (secs) => new Date(secs * 1000).toISOString().slice(0, 10)

const blankDay = () => ({
  calls: 0,
  tokens: 0,
  input_tokens: 0,
  cache_hit_tokens: 0,
  unmetered: 0,
  estimated: 0,
})

export async function readLedger(root, userId) {
  const ledger = { days: {}, seen: {} }
  let doc = {}
  try {
    doc = await readJson(ledgerFile(root, userId))
  } catch {
    return ledger
  }
  for (const [day, per] of Object.entries(doc?.days ?? {})) {
    const row = {}
    for (const [agent, usage] of Object.entries(per ?? {})) {
      const here = blankDay()
      for (const key of Object.keys(here)) here[key] = number_of(usage?.[key])
      row[agent] = here
    }
    ledger.days[day] = row
  }
  for (const [key, at] of Object.entries(doc?.seen ?? {})) {
    if (Number.isInteger(at)) ledger.seen[key] = at
  }
  return ledger
}

export async function saveLedger(root, userId, ledger) {
  await atomicJson(ledgerFile(root, userId), ledger)
}

/**
 * 把世界这次的请求台账折进跨天账本：按请求号去重，还在路上的等它落定。
 * `owners` 是 居民 → agent 编号，不是自己投的那几位不记。
 */
export function foldLedger(ledger, town, usage, owners) {
  const now = nowSecs()
  for (const request of usage?.requests ?? []) {
    const resident = request?.resident_id
    const agent = owners.get(resident)
    if (!agent) continue
    // 还在路上的不算：等它落定，下一次折账本时再计一次（旧存档里的中文值也认）
    if (request.status === 'in_flight' || request.status === '进行中') continue
    const sentAt = number_of(request.sent_at)
    const at = sentAt === 0 ? now : sentAt
    const key = `${town}/${resident}/${at}/${number_of(request.id)}`
    if (ledger.seen[key] != null) continue
    ledger.seen[key] = at
    const day = dayOf(at)
    if (!ledger.days[day]) ledger.days[day] = {}
    if (!ledger.days[day][agent]) ledger.days[day][agent] = blankDay()
    const here = ledger.days[day][agent]
    here.calls += 1
    const input = Number.isInteger(request.input_tokens) ? request.input_tokens : null
    const output = Number.isInteger(request.output_tokens) ? request.output_tokens : null
    if (input !== null || output !== null) {
      here.tokens += (input ?? 0) + (output ?? 0)
      here.input_tokens += input ?? 0
      here.cache_hit_tokens += number_of(request.cache_hit_tokens)
    } else {
      // 没报计量的那次：真花掉的钱是「不知道」，估算值另放一栏，不写成 0 token
      here.unmetered += 1
      here.estimated += number_of(request.reserved_tokens)
    }
  }
}

/** 留 30 天的日账、8 天的请求号：再旧的世界那边也早看不到了。 */
export function pruneLedger(ledger, now = nowSecs()) {
  const keepDays = dayOf(now - 30 * 86400)
  for (const day of Object.keys(ledger.days)) if (day < keepDays) delete ledger.days[day]
  const keepAfter = now - 8 * 86400
  for (const [key, at] of Object.entries(ledger.seen)) if (at < keepAfter) delete ledger.seen[key]
}

/** 最近几天的账，新的在前。 */
export function historyOf(ledger, days, names = new Map()) {
  return Object.keys(ledger.days)
    .sort()
    .reverse()
    .slice(0, days)
    .map((day) => {
      const sums = blankDay()
      const agents = []
      for (const [agent, here] of Object.entries(ledger.days[day])) {
        sums.calls += here.calls
        sums.tokens += here.tokens
        sums.input_tokens += here.input_tokens
        sums.cache_hit_tokens += here.cache_hit_tokens
        sums.unmetered += here.unmetered
        sums.estimated += here.estimated
        agents.push({
          agent_id: agent,
          name: names.get(agent) ?? agent,
          calls: here.calls,
          tokens: here.tokens,
          unmetered: here.unmetered,
        })
      }
      return { day, ...sums, agents }
    })
}

/** 某个镇此刻的用量（没在跑就是 null）。 */
async function usageOf(hosts, town) {
  if (!hosts.isRunning(town)) return null
  try {
    return await hosts.query(town, { type: 'get_usage' }, (m) => m.type === 'usage')
  } catch {
    return null
  }
}

/** 心跳里顺手折一次：人不在首页（没有 GET /usage）也不会把昨天丢掉。 */
export async function foldTowns({ root, userId, hosts }) {
  const agents = await listAgents(root, userId)
  if (!agents.length) return
  const towns = new Map()
  const owners = new Map()
  for (const agent of agents) {
    for (const [town, record] of Object.entries(agent.deployed ?? {})) {
      if (!towns.has(town)) towns.set(town, await usageOf(hosts, town))
      if (!owners.has(town)) owners.set(town, new Map())
      owners.get(town).set(record.resident, agent.id)
    }
  }
  const ledger = await readLedger(root, userId)
  const before = JSON.stringify(ledger)
  for (const [town, usage] of towns) {
    const mine = owners.get(town)
    if (usage && mine) foldLedger(ledger, town, usage, mine)
  }
  pruneLedger(ledger)
  if (JSON.stringify(ledger) !== before) await saveLedger(root, userId, ledger)
}

/**
 * 这个账号今天用了多少：把每个镇里自己那几位居民的用量加起来。
 * 只算已经投出去的居民——定义还在手里的时候不花任何人的钱。
 */
export async function usageSummary({ root, userId, hosts, storage }) {
  const agents = await listAgents(root, userId)
  const budget = await readBudget(root, userId)
  const towns = new Map()
  const owners = new Map()
  const names = new Map()
  const rows = []
  const totals = { calls: 0, tokens: 0, unmetered: 0 }
  for (const agent of agents) {
    names.set(agent.id, agent.name)
    for (const [town, record] of Object.entries(agent.deployed ?? {})) {
      if (!towns.has(town)) towns.set(town, await usageOf(hosts, town))
      // 居民 → agent：世界只知道居民，账号这边记着他是谁投的
      if (!owners.has(town)) owners.set(town, new Map())
      owners.get(town).set(record.resident, agent.id)
      const usage = towns.get(town)
      const row = (usage?.residents ?? []).find((item) => item.id === record.resident) ?? null
      const mine = (usage?.requests ?? []).filter(
        (item) => item.resident_id === record.resident && item.unmetered === true
      )
      const calls = number_of(row?.daily_calls)
      const tokens = number_of(row?.daily_tokens)
      totals.calls += calls
      totals.tokens += tokens
      totals.unmetered += mine.length
      rows.push({
        agent_id: agent.id,
        name: agent.name,
        town,
        town_name: await townName(storage, town),
        running: usage !== null,
        resident: record.resident,
        resident_name: record.name,
        calls,
        tokens,
        input_tokens: number_of(row?.daily_input_tokens),
        cache_hit_tokens: number_of(row?.daily_cache_hit_tokens),
        replies: number_of(row?.replies),
        in_flight: number_of(row?.in_flight),
        paused: row?.paused ?? null,
        unmetered: mine.length,
      })
    }
  }
  // 账本是给「过了今天」看的：世界的日计数会在换天时归零，这里留一份不会丢的
  const ledger = await readLedger(root, userId)
  const before = JSON.stringify(ledger)
  for (const [town, usage] of towns) {
    const mine = owners.get(town)
    if (usage && mine) foldLedger(ledger, town, usage, mine)
  }
  pruneLedger(ledger)
  if (JSON.stringify(ledger) !== before) await saveLedger(root, userId, ledger)
  return { ok: true, budget, totals, agents: rows, history: historyOf(ledger, 7, names) }
}
