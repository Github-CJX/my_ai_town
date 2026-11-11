// 账号自己的用量与额度：世界按居民记用量，管理服务把居民换回账号的 agent 再汇总
// （crates/manager/src/usage.rs 的同一份规则）。额度住在账号目录的 budget.json 里，
// 限定这个账号投出去的每位居民每天的调用数与 token 数，由世界按居民执行（set_resident_budget）。
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { HttpError } from './http.mjs'
import { listAgents } from './agents.mjs'
import { addRequest, dayRows, openLedgerWithOld, pruneLedger, recentDays } from './ledger.mjs'
import { costMicros, priceTable } from './prices.mjs'
import { atomicJson, readJson, safeId } from './storage.mjs'

const hex = (bytes) => randomBytes(bytes).toString('hex')

/** 账号自己的每日额度存这里；两项都空 = 各用世界的全镇额度。 */
export const budgetFile = (root, userId) => path.join(root, 'users', safeId(userId), 'budget.json')

export function hasBudget(budget) {
  return (
    budget?.calls_per_day != null ||
    budget?.tokens_per_day != null ||
    budget?.max_concurrent != null ||
    budget?.per_minute != null
  )
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
  if (Number.isInteger(doc?.max_concurrent) && doc.max_concurrent > 0)
    budget.max_concurrent = doc.max_concurrent
  if (Number.isInteger(doc?.per_minute) && doc.per_minute > 0) budget.per_minute = doc.per_minute
  return budget
}

function number(body, key) {
  const value = body?.[key]
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0) throw new HttpError(400, `${key} 须是不小于 0 的整数`)
  return value
}

/** 并发与速率这类小整数：给了就得在范围内。 */
function small(body, key, low, high, unit) {
  const value = number(body, key)
  if (value === null) return null
  if (value < low || value > high) throw new HttpError(400, `${key} 须为 ${low}–${high}${unit}`)
  return value
}

/** 存下来。两项都可以不带（= 回到全镇额度），但给了就不能是 0；并发与速率同理。 */
export async function saveBudget(root, userId, body) {
  const calls = number(body, 'calls_per_day')
  const tokens = number(body, 'tokens_per_day')
  if (calls === 0) throw new HttpError(400, '每日调用上限须大于 0')
  if (tokens === 0) throw new HttpError(400, '每日 token 上限须大于 0')
  const budget = {}
  if (calls !== null) budget.calls_per_day = calls
  if (tokens !== null) budget.tokens_per_day = tokens
  const concurrent = small(body, 'max_concurrent', 1, 16, '')
  const rate = small(body, 'per_minute', 1, 600, ' 次')
  if (concurrent !== null) budget.max_concurrent = concurrent
  if (rate !== null) budget.per_minute = rate
  await atomicJson(budgetFile(root, userId), budget)
  return budget
}

/** 世界不认识账号，只认「组标签」：同一个账号的 agent 共用一组并发与速率。 */
export const groupOf = (owner) => `acct-${owner}`

/**
 * 把账号的额度发给正在跑的小镇：一位居民发一条，世界按居民执行。
 * 没在跑的小镇跳过——等它下次起来，投放/心跳会再发一次。
 */
export async function pushBudget(hosts, town, agents, budget, owner) {
  if (!hosts.isRunning(town)) return
  for (const agent of agents) {
    const record = agent.deployed?.[town]
    if (!record) continue
    const requestId = `budget-${agent.id}-${hex(8)}`
    const command = {
      type: 'set_resident_budget',
      request_id: requestId,
      resident: record.resident,
      group: groupOf(owner),
    }
    if (budget.calls_per_day != null) command.calls_per_day = budget.calls_per_day
    if (budget.tokens_per_day != null) command.tokens_per_day = budget.tokens_per_day
    if (budget.max_concurrent != null) command.max_concurrent = budget.max_concurrent
    if (budget.per_minute != null) command.per_minute = budget.per_minute
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

const nowSecs = () => Math.floor(Date.now() / 1000)

/** Unix 秒 → UTC 日期 `YYYY-MM-DD`（和 Rust 那边同一套算法）。 */
const dayOf = (secs) => new Date(secs * 1000).toISOString().slice(0, 10)

const DAY_KEYS = [
  'calls',
  'tokens',
  'input_tokens',
  'cache_hit_tokens',
  'unmetered',
  'estimated',
  'cost_micros',
  'priced',
  'unpriced',
]

const blankDay = () => Object.fromEntries(DAY_KEYS.map((key) => [key, 0]))

/**
 * 把世界这次的请求台账折进库：`(镇, 请求号)` 唯一，折过就不再计；还在路上的等它落定。
 * `owners` 是 居民 → agent 编号，不是自己投的那几位不记。
 */
export function foldLedger(db, town, usage, owners, prices = new Map()) {
  const now = nowSecs()
  for (const request of usage?.requests ?? []) {
    const resident = request?.resident_id
    const agent = owners.get(resident)
    if (!agent) continue
    // 还在路上的不算：等它落定，下一次折账本时再计一次（旧存档里的中文值也认）
    if (request.status === 'in_flight' || request.status === '进行中') continue
    const sentAt = number_of(request.sent_at)
    const at = sentAt === 0 ? now : sentAt
    const input = Number.isInteger(request.input_tokens) ? request.input_tokens : null
    const output = Number.isInteger(request.output_tokens) ? request.output_tokens : null
    const metered = input !== null || output !== null
    const cache = number_of(request.cache_hit_tokens)
    addRequest(db, {
      town,
      request_id: `${at}/${number_of(request.id)}`,
      resident,
      agent,
      day: dayOf(at),
      sent_at: at,
      model: request.model ?? null,
      status: request.status ?? '',
      input: input ?? 0,
      cache,
      output: output ?? 0,
      reserved: number_of(request.reserved_tokens),
      metered,
      cost: metered ? costMicros(prices, request.model, input ?? 0, cache, output ?? 0) : null,
    })
  }
}

/** 最近几天的账，新的在前：`recent` 是 `recentDays()` 的结果。 */
export function historyOf(recent, names = new Map()) {
  return recent.map(([day, perAgent]) => {
    const sums = blankDay()
    const agents = []
    for (const [agent, here] of perAgent) {
      for (const key of DAY_KEYS) sums[key] += number_of(here?.[key])
      agents.push({
        agent_id: agent,
        name: names.get(agent) ?? agent,
        calls: here.calls,
        tokens: here.tokens,
        unmetered: here.unmetered,
        cost_micros: here.cost_micros,
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
  const db = await openLedgerWithOld(root, userId)
  try {
    const prices = await priceTable(root, userId)
    for (const [town, usage] of towns) {
      const mine = owners.get(town)
      if (usage && mine) foldLedger(db, town, usage, mine, prices)
    }
    // 留 30 天：再旧的世界那边也早看不到了
    pruneLedger(db, dayOf(nowSecs() - 30 * 86400))
  } finally {
    db.close()
  }
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
  const db = await openLedgerWithOld(root, userId)
  let today
  let history
  try {
    const prices = await priceTable(root, userId)
    for (const [town, usage] of towns) {
      const mine = owners.get(town)
      if (usage && mine) foldLedger(db, town, usage, mine, prices)
    }
    pruneLedger(db, dayOf(nowSecs() - 30 * 86400))
    // 今天花掉的钱只存在账本里（世界的 resident 行只有 token）
    today = dayRows(db, dayOf(nowSecs()))
    history = historyOf(recentDays(db, 7), names)
  } finally {
    db.close()
  }
  let costMicrosToday = 0
  let pricedToday = 0
  let unpricedToday = 0
  for (const here of today.values()) {
    costMicrosToday += here.cost_micros
    pricedToday += here.priced
    unpricedToday += here.unpriced
  }
  for (const row of rows) row.cost_micros = today.get(row.agent_id)?.cost_micros ?? 0
  totals.cost_micros = costMicrosToday
  totals.priced = pricedToday
  totals.unpriced = unpricedToday
  return { ok: true, budget, totals, agents: rows, history }
}
