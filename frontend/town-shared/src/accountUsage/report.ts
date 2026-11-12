// 账号自己的用量：世界按居民记账（谁会花自己的钱），管理服务把这笔账折回账号的 agent，
// 跨天落进 usage.db。这一层只管数字与文字——不碰 DOM、不引样式，面板和测试共用同一份口径。
// 金额的口径与 pricing.ts 的 yuan() 一致（下面 moneyText 的断言拿它对照）：一分钱以下说「不到 ¥0.01」。

/** 今天的合计（世界把各镇各居民的记账加在一起，管理服务按账号的 agent 筛过） */
export type UsageTotals = {
  calls: number
  tokens: number
  /** 服务商没回计量的次数：这几次花了多少不知道 */
  unmetered: number
  /** 微元（元 × 1 000 000）：只算价目表里有的模型 */
  cost_micros: number
  /** 算进了钱的请求数 / 有计量但价目表里没收录的请求数 */
  priced: number
  unpriced: number
}

/** 投出去的某一位今天的用量 */
export type UsageRow = {
  name: string
  town_name: string
  resident_name: string
  /** 那个小镇此刻在不在运行：没在跑时记 0（不是「没花」，是「不知道」） */
  running: boolean
  paused: unknown
  calls: number
  tokens: number
  input_tokens: number
  cache_hit_tokens: number
  in_flight: number
  unmetered: number
  replies: number
  cost_micros: number
}

/** 账本里的某一天 */
export type UsageDay = {
  day: string
  calls: number
  tokens: number
  input_tokens: number
  cache_hit_tokens: number
  unmetered: number
  cost_micros: number
  priced: number
  unpriced: number
}

/** 账号自己的每日额度：空着的那项照小镇自己的上限算 */
export type UsageBudget = {
  calls_per_day?: number
  tokens_per_day?: number
  max_concurrent?: number
  per_minute?: number
}

/** 一万以上按 k 说；一万以下留一位小数，免得「1.0k」和「12k」两种粒度混着 */
export function countText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
}

export const tokenText = (n: number) => `${countText(n)} token`

/** 微元 → 钱：一分钱以下说「不到 ¥0.01」，不写成 ¥0（那会像是没花钱） */
export function moneyText(micros: number): string {
  if (!Number.isFinite(micros) || micros <= 0) return '¥0'
  const value = micros / 1_000_000
  return value < 0.01 ? '不到 ¥0.01' : `¥${value.toFixed(2)}`
}

/** 缓存命中率：没有输入就没有分母 */
export function hitText(hit: number, input: number): string {
  if (!(input > 0)) return '—'
  return `${Math.round((Math.min(Math.max(hit, 0), input) / input) * 100)}%`
}

/** 表里的天数：账本写 YYYY-MM-DD，摆在表头只写 MM-DD */
export function dayText(day: string): string {
  const found = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  return found ? `${found[1]}-${found[2]}` : day
}

/** 近几天合计：今天之外的也留着（换天归零不会把这些丢了） */
export function weekOf(history: UsageDay[]) {
  return history.reduce(
    (sum, day) => ({
      days: sum.days + 1,
      calls: sum.calls + (day.calls || 0),
      tokens: sum.tokens + (day.tokens || 0),
      input_tokens: sum.input_tokens + (day.input_tokens || 0),
      cache_hit_tokens: sum.cache_hit_tokens + (day.cache_hit_tokens || 0),
      cost_micros: sum.cost_micros + (day.cost_micros || 0),
    }),
    { days: 0, calls: 0, tokens: 0, input_tokens: 0, cache_hit_tokens: 0, cost_micros: 0 }
  )
}

/** 一位投出去的 agent 现在什么状态：在途、已停、小镇没在跑，还是闲着 */
export function rowState(row: UsageRow): { text: string; cls: string } {
  if (!row.running) return { text: '小镇没在跑', cls: 'dim' }
  if (row.paused) return { text: '已停', cls: 'drop' }
  if (row.in_flight > 0) return { text: `在途 ${row.in_flight}`, cls: 'busy' }
  return { text: '正常', cls: 'ok' }
}

/** 额度写成一句话：没设的那几项说「照小镇的」，不是「不限」（其实还受小镇约束） */
export function budgetText(budget: UsageBudget): string {
  const parts = [
    `每天 ${budget.calls_per_day ? `${countText(budget.calls_per_day)} 次` : '照小镇的次数'}`,
    `token ${budget.tokens_per_day ? countText(budget.tokens_per_day) : '照小镇的额度'}`,
  ]
  if (budget.max_concurrent) parts.push(`同时 ${budget.max_concurrent} 件事`)
  if (budget.per_minute) parts.push(`每分钟 ${budget.per_minute} 次`)
  return parts.join(' · ')
}

/** 钱算不全时照实说：没回计量的、价目表里没收录的，各说各的，不并成一句「约」 */
export function missingText(totals: { unmetered?: number; unpriced?: number }): string {
  const parts: string[] = []
  if (totals.unmetered) parts.push(`${totals.unmetered} 次服务商没回计量`)
  if (totals.unpriced) parts.push(`${totals.unpriced} 次价目表里没有`)
  return parts.length ? `${parts.join('、')}，钱没算全` : ''
}
