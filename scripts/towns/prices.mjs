// 价目表：Node 私人服把 token 用量换算成钱。
// 单位统一为人民币元 / 百万 token：输入（缓存未命中）、输入（缓存命中）、输出三档。
// 账号目录里可以放 prices.json 覆盖或补充内置价；表里没有的模型记「没价」，不折算成 0。
import path from 'node:path'
import { readJson, safeId } from './storage.mjs'

/** 内置价目表：键是台账里记的 `服务商/模型`（元 / 百万 token，2026 年公开价）。 */
const BUILTIN = {
  'deepseek/deepseek-chat': { input: 2.0, cache: 0.5, output: 8.0 },
  'deepseek/deepseek-reasoner': { input: 4.0, cache: 1.0, output: 16.0 },
}

/** 账号目录里的价目表文件。 */
export const priceFile = (root, userId) => path.join(root, 'users', safeId(userId), 'prices.json')

const isPrice = (value) =>
  value != null &&
  typeof value === 'object' &&
  ['input', 'cache', 'output'].every((key) => Number.isFinite(value[key]) && value[key] >= 0)

/** 读价目表：内置的，加上账号目录里的覆盖。文件不在、读坏了、某项写错了都不影响其余项照用。 */
export async function priceTable(root, userId) {
  const prices = new Map(Object.entries(BUILTIN))
  let doc = null
  try {
    doc = await readJson(priceFile(root, userId))
  } catch {
    return prices
  }
  for (const [key, value] of Object.entries(doc ?? {})) {
    if (isPrice(value)) prices.set(key, value)
  }
  return prices
}

/** 查价：先整串 `服务商/模型`，再退回只按模型名（两个方向都认）。 */
export function priceOf(prices, model) {
  if (typeof model !== 'string' || model === '') return null
  if (prices.has(model)) return prices.get(model)
  const cut = model.indexOf('/')
  if (cut >= 0) return prices.get(model.slice(cut + 1)) ?? null
  for (const [key, price] of prices) {
    const at = key.lastIndexOf('/')
    if (at >= 0 && key.slice(at + 1) === model) return price
  }
  return null
}

/**
 * 这一次请求花多少：微元（元 × 1 000 000）的整数，免得浮点加着加着漂。
 * `input` 含缓存命中的部分，命中部分按 `cache` 价算。没价 → null（不是 0）。
 */
export function costMicros(prices, model, input, cache, output) {
  const price = priceOf(prices, model)
  if (!price) return null
  const hit = Math.min(cache ?? 0, input ?? 0)
  const miss = (input ?? 0) - hit
  const total = miss * price.input + hit * price.cache + (output ?? 0) * price.output
  return Math.max(0, Math.round(total))
}
