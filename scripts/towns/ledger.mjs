// 用量台账落 SQLite：一次请求一行，另有一张按天按人的汇总。
//
// 为什么不是 JSON：请求行要能按 `(镇, 请求号)` 唯一去重（世界重启后请求号会从头来，
// 所以号里带着镇与发出时间），一天几千次要反复折叠、按天聚合、清理旧数据——这些用 SQL
// 是两行查询，用 JSON 得整个文件读进来再写回去。账号目录里的 `usage.db` 由 Rust 与 Node
// 两边共同读写（Rust 用 rusqlite），所以**两边的建表语句必须逐字一致**
// （crates/manager/src/ledger.rs）。
//
// 旧版本用的是 `usage.json`：第一次打开新库时把里面的日汇总导进来，再把文件改名留底。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HttpError } from './http.mjs'
import { readJson, safeId } from './storage.mjs'

/** 账号目录里的账本文件。 */
export const ledgerFile = (root, userId) => path.join(root, 'users', safeId(userId), 'usage.db')

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

const number_of = (value) => (Number.isInteger(value) ? value : 0)

/** 出错时保留是哪一步：台账坏了要能看出是打开、建表还是写入。 */
const sql = (step) => (error) => new HttpError(500, `账本${step}失败：${error?.message ?? error}`)

/** 打开（必要时新建）账本。`busy_timeout` 让两个进程偶尔撞车时等一会儿，而不是直接报错。 */
export function openLedger(root, userId) {
  const file = ledgerFile(root, userId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let db
  try {
    db = new DatabaseSync(file)
    db.exec(
      `PRAGMA busy_timeout = 3000;
       CREATE TABLE IF NOT EXISTS request(
          town TEXT NOT NULL,
          request_id TEXT NOT NULL,
          resident TEXT NOT NULL,
          agent TEXT NOT NULL,
          day TEXT NOT NULL,
          sent_at INTEGER NOT NULL,
          model TEXT,
          status TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          reserved_tokens INTEGER NOT NULL DEFAULT 0,
          unmetered INTEGER NOT NULL DEFAULT 0,
          cost_micros INTEGER NOT NULL DEFAULT 0,
          priced INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(town, request_id));
       CREATE INDEX IF NOT EXISTS request_by_day ON request(day, agent);
       CREATE TABLE IF NOT EXISTS day(
          day TEXT NOT NULL,
          agent TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0,
          tokens INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
          unmetered INTEGER NOT NULL DEFAULT 0,
          estimated INTEGER NOT NULL DEFAULT 0,
          cost_micros INTEGER NOT NULL DEFAULT 0,
          priced INTEGER NOT NULL DEFAULT 0,
          unpriced INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(day, agent));`
    )
  } catch (error) {
    throw sql('建表')(error)
  }
  return db
}

/**
 * 记一条请求：`(town, request_id)` 已经记过就什么都不做（世界台账可能被反复折叠）。
 * 返回是不是新记的。`entry` 形如
 * `{ town, request_id, resident, agent, day, sent_at, model, status, input, cache, output, reserved, metered, cost }`。
 */
export function addRequest(db, entry) {
  const tokens = entry.metered ? entry.input + entry.output : 0
  try {
    db.exec('BEGIN IMMEDIATE')
    const added = db
      .prepare(
        `INSERT OR IGNORE INTO request(
            town, request_id, resident, agent, day, sent_at, model, status,
            input_tokens, cache_hit_tokens, output_tokens, reserved_tokens,
            unmetered, cost_micros, priced)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        entry.town,
        entry.request_id,
        entry.resident,
        entry.agent,
        entry.day,
        entry.sent_at,
        entry.model ?? null,
        entry.status,
        entry.input,
        entry.cache,
        entry.output,
        entry.reserved,
        entry.metered ? 0 : 1,
        entry.cost ?? 0,
        entry.cost == null ? 0 : 1
      ).changes
    if (!added) {
      db.exec('ROLLBACK')
      return false
    }
    // 汇总表跟着动：一条请求只落一次，所以 += 不会重复
    const unpriced = entry.metered && entry.cost == null ? 1 : 0
    db.prepare(
      `INSERT INTO day(
          day, agent, calls, tokens, input_tokens, cache_hit_tokens,
          unmetered, estimated, cost_micros, priced, unpriced)
       VALUES (?,?,1,?,?,?,?,?,?,?,?)
       ON CONFLICT(day, agent) DO UPDATE SET
          calls = calls + 1,
          tokens = tokens + excluded.tokens,
          input_tokens = input_tokens + excluded.input_tokens,
          cache_hit_tokens = cache_hit_tokens + excluded.cache_hit_tokens,
          unmetered = unmetered + excluded.unmetered,
          estimated = estimated + excluded.estimated,
          cost_micros = cost_micros + excluded.cost_micros,
          priced = priced + excluded.priced,
          unpriced = unpriced + excluded.unpriced`
    ).run(
      entry.day,
      entry.agent,
      tokens,
      entry.metered ? entry.input : 0,
      entry.cache,
      entry.metered ? 0 : 1,
      // 估算值只给「没报计量」的那次：报回来的是真数，不再叠预留
      entry.metered ? 0 : entry.reserved,
      entry.cost ?? 0,
      entry.cost == null ? 0 : 1,
      unpriced
    )
    db.exec('COMMIT')
    return true
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务没开起来，不用回滚
    }
    throw sql('写请求')(error)
  }
}

const ROW_SQL = `SELECT day, agent, calls, tokens, input_tokens, cache_hit_tokens,
    unmetered, estimated, cost_micros, priced, unpriced FROM day`

const rowOf = (row) => {
  const usage = blankDay()
  for (const key of DAY_KEYS) usage[key] = number_of(row[key])
  return usage
}

/** 最近 `keep` 天，新的在前：`[[day, Map<agent, DayUsage>], …]`。 */
export function recentDays(db, keep) {
  try {
    const rows = db
      .prepare(
        `${ROW_SQL} WHERE day IN (SELECT DISTINCT day FROM day ORDER BY day DESC LIMIT ?)
         ORDER BY day DESC, agent`
      )
      .all(keep)
    const out = []
    for (const row of rows) {
      if (out.at(-1)?.[0] !== row.day) out.push([row.day, new Map()])
      out.at(-1)[1].set(row.agent, rowOf(row))
    }
    return out
  } catch (error) {
    throw sql('读日账')(error)
  }
}

/** 某一天的日账：账号今天花了多少从这里取（世界的居民行里只有 token，没有钱）。 */
export function dayRows(db, day) {
  try {
    const rows = db.prepare(`${ROW_SQL} WHERE day = ? ORDER BY agent`).all(day)
    return new Map(rows.map((row) => [row.agent, rowOf(row)]))
  } catch (error) {
    throw sql('读日账')(error)
  }
}

/** 只留 `before`（UTC 日）之后的请求与日账。 */
export function pruneLedger(db, before) {
  try {
    db.prepare('DELETE FROM request WHERE day < ?').run(before)
    db.prepare('DELETE FROM day WHERE day < ?').run(before)
  } catch (error) {
    throw sql('清理账本')(error)
  }
}

/** 顺手查一次请求行数：对账时看「世界说发了多少次」对不对得上。 */
export function countRequests(db) {
  try {
    return number_of(db.prepare('SELECT COUNT(*) FROM request').get()['COUNT(*)'])
  } catch (error) {
    throw sql('数请求')(error)
  }
}

/** 旧版本的 `usage.json`：把日汇总导进来，再把文件改名留底（不再读第二次）。 */
export async function importJson(db, root, userId) {
  const old = path.join(root, 'users', safeId(userId), 'usage.json')
  if (!fs.existsSync(old)) return
  let doc = {}
  try {
    doc = await readJson(old)
  } catch {
    doc = {}
  }
  try {
    for (const [day, agents] of Object.entries(doc?.days ?? {})) {
      for (const [agent, usage] of Object.entries(agents ?? {})) {
        db.prepare(
          `INSERT OR IGNORE INTO day(
              day, agent, calls, tokens, input_tokens, cache_hit_tokens,
              unmetered, estimated, cost_micros, priced, unpriced)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).run(day, agent, ...DAY_KEYS.map((key) => number_of(usage?.[key])))
      }
    }
  } catch (error) {
    throw sql('导入旧账')(error)
  }
  fs.renameSync(old, `${old}.imported`)
}

/** 打开账本并顺手导入旧 JSON（两边共用的入口）。 */
export async function openLedgerWithOld(root, userId) {
  const db = openLedger(root, userId)
  await importJson(db, root, userId)
  return db
}
