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

/**
 * 这个账号今天用了多少：把每个镇里自己那几位居民的用量加起来。
 * 只算已经投出去的居民——定义还在手里的时候不花任何人的钱。
 */
export async function usageSummary({ root, userId, hosts, storage }) {
  const agents = await listAgents(root, userId)
  const budget = await readBudget(root, userId)
  const towns = new Map()
  const rows = []
  const totals = { calls: 0, tokens: 0, unmetered: 0 }
  for (const agent of agents) {
    for (const [town, record] of Object.entries(agent.deployed ?? {})) {
      if (!towns.has(town)) {
        let usage = null
        if (hosts.isRunning(town)) {
          try {
            usage = await hosts.query(town, { type: 'get_usage' }, (m) => m.type === 'usage')
          } catch {
            usage = null
          }
        }
        towns.set(town, usage)
      }
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
  return { ok: true, budget, totals, agents: rows }
}
