//! 用量台账落 SQLite：一次请求一行，另有一张按天按人的汇总。
//!
//! 为什么不是 JSON：请求行要能按 `(镇, 请求号)` 唯一去重（世界重启后请求号会从头来，
//! 所以号里带着镇与发出时间），一天几千次要反复折叠、按天聚合、清理旧数据——这些用 SQL
//! 是两行查询，用 JSON 得整个文件读进来再写回去。账号目录里的 `usage.db` 由 Rust 与 Node
//! 两边共同读写（Node 用 `node:sqlite`），所以**两边的建表语句必须逐字一致**。
//!
//! 旧版本用的是 `usage.json`：第一次打开新库时把里面的日汇总导进来，再把文件改名留底。
use crate::error::ApiError;
use crate::usage::DayUsage;
use rusqlite::{params, Connection};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 账号目录里的账本文件。
pub fn file(home: &Path) -> PathBuf {
    home.join("usage.db")
}

/// 出错时保留是哪一步：台账坏了要能看出是打开、建表还是写入。
fn sql(step: &str) -> impl Fn(rusqlite::Error) -> ApiError + '_ {
    move |error| ApiError::new(500, format!("账本{step}失败：{error}"))
}

/// 打开（必要时新建）账本。`busy_timeout` 让两个进程偶尔撞车时等一会儿，而不是直接报错。
pub fn open(home: &Path) -> Result<Connection, ApiError> {
    let connection = Connection::open(file(home)).map_err(sql("打开"))?;
    connection
        .execute_batch(
            "PRAGMA busy_timeout = 3000;
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
                PRIMARY KEY(day, agent));",
        )
        .map_err(sql("建表"))?;
    import_json(&connection, home)?;
    Ok(connection)
}

/// 一条已经落定的请求。`priced` 与 `unpriced` 互斥：有计量、价目表里也有这个模型才算有钱。
pub struct Entry<'a> {
    pub town: &'a str,
    pub request_id: &'a str,
    pub resident: &'a str,
    pub agent: &'a str,
    pub day: &'a str,
    pub sent_at: u64,
    pub model: Option<&'a str>,
    pub status: &'a str,
    pub input: u64,
    pub cache: u64,
    pub output: u64,
    pub reserved: u64,
    pub metered: bool,
    pub cost: Option<u64>,
}

/// 记一条请求：`(town, request_id)` 已经记过就什么都不做（世界台账可能被反复折叠）。
/// 返回是不是新记的。
pub fn add(connection: &mut Connection, entry: &Entry) -> Result<bool, ApiError> {
    let tokens = if entry.metered {
        entry.input + entry.output
    } else {
        0
    };
    let tx = connection.transaction().map_err(sql("开启事务"))?;
    let added = tx
        .execute(
            "INSERT OR IGNORE INTO request(
                town, request_id, resident, agent, day, sent_at, model, status,
                input_tokens, cache_hit_tokens, output_tokens, reserved_tokens,
                unmetered, cost_micros, priced)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                entry.town,
                entry.request_id,
                entry.resident,
                entry.agent,
                entry.day,
                entry.sent_at as i64,
                entry.model,
                entry.status,
                entry.input as i64,
                entry.cache as i64,
                entry.output as i64,
                entry.reserved as i64,
                !entry.metered as i64,
                entry.cost.unwrap_or(0) as i64,
                entry.cost.is_some() as i64,
            ],
        )
        .map_err(sql("写请求"))?
        == 1;
    if !added {
        return Ok(false);
    }
    // 汇总表跟着动：一条请求只落一次，所以 += 不会重复
    let unpriced = (entry.metered && entry.cost.is_none()) as u64;
    tx.execute(
        "INSERT INTO day(
            day, agent, calls, tokens, input_tokens, cache_hit_tokens,
            unmetered, estimated, cost_micros, priced, unpriced)
         VALUES (?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(day, agent) DO UPDATE SET
            calls = calls + 1,
            tokens = tokens + excluded.tokens,
            input_tokens = input_tokens + excluded.input_tokens,
            cache_hit_tokens = cache_hit_tokens + excluded.cache_hit_tokens,
            unmetered = unmetered + excluded.unmetered,
            estimated = estimated + excluded.estimated,
            cost_micros = cost_micros + excluded.cost_micros,
            priced = priced + excluded.priced,
            unpriced = unpriced + excluded.unpriced",
        params![
            entry.day,
            entry.agent,
            tokens as i64,
            if entry.metered { entry.input as i64 } else { 0 },
            entry.cache as i64,
            !entry.metered as i64,
            // 估算值只给「没报计量」的那次：报回来的是真数，不再叠预留
            if entry.metered {
                0
            } else {
                entry.reserved as i64
            },
            entry.cost.unwrap_or(0) as i64,
            entry.cost.is_some() as i64,
            unpriced as i64,
        ],
    )
    .map_err(sql("写日汇总"))?;
    tx.commit().map_err(sql("提交"))?;
    Ok(true)
}

/// 一天一个人：从 `day` 行读出来。
fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, DayUsage)> {
    Ok((
        row.get::<_, String>(1)?,
        DayUsage {
            calls: row.get::<_, i64>(2)? as u64,
            tokens: row.get::<_, i64>(3)? as u64,
            input_tokens: row.get::<_, i64>(4)? as u64,
            cache_hit_tokens: row.get::<_, i64>(5)? as u64,
            unmetered: row.get::<_, i64>(6)? as u64,
            estimated: row.get::<_, i64>(7)? as u64,
            cost_micros: row.get::<_, i64>(8)? as u64,
            priced: row.get::<_, i64>(9)? as u64,
            unpriced: row.get::<_, i64>(10)? as u64,
        },
    ))
}

const ROW_SQL: &str = "SELECT day, agent, calls, tokens, input_tokens, cache_hit_tokens,
        unmetered, estimated, cost_micros, priced, unpriced FROM day";

/// 最近 `keep` 天，新的在前；每天带一位 agent 一行。
pub fn days(
    connection: &Connection,
    keep: usize,
) -> Result<Vec<(String, BTreeMap<String, DayUsage>)>, ApiError> {
    let mut statement = connection
        .prepare(&format!(
            "{ROW_SQL} WHERE day IN (SELECT DISTINCT day FROM day ORDER BY day DESC LIMIT ?1)
             ORDER BY day DESC, agent"
        ))
        .map_err(sql("读日账"))?;
    let rows = statement
        .query_map(params![keep as i64], |row| {
            Ok((row.get::<_, String>(0)?, read_row(row)?))
        })
        .map_err(sql("读日账"))?;
    let mut out: Vec<(String, BTreeMap<String, DayUsage>)> = Vec::new();
    for row in rows {
        let (day, (agent, usage)) = row.map_err(sql("读日账"))?;
        match out.last_mut() {
            Some((current, agents)) if *current == day => {
                agents.insert(agent, usage);
            }
            _ => out.push((day, BTreeMap::from([(agent, usage)]))),
        }
    }
    Ok(out)
}

/// 某一天的日账：账号今天花了多少从这里取（世界的居民行里只有 token，没有钱）。
pub fn day(connection: &Connection, day: &str) -> Result<BTreeMap<String, DayUsage>, ApiError> {
    let mut statement = connection
        .prepare(&format!("{ROW_SQL} WHERE day = ?1 ORDER BY agent"))
        .map_err(sql("读日账"))?;
    let rows = statement
        .query_map(params![day], |row| read_row(row))
        .map_err(sql("读日账"))?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (agent, usage) = row.map_err(sql("读日账"))?;
        out.insert(agent, usage);
    }
    Ok(out)
}

/// 只留 `before`（UTC 日）之后的请求与日账。
pub fn prune(connection: &Connection, before: &str) -> Result<(), ApiError> {
    connection
        .execute("DELETE FROM request WHERE day < ?1", params![before])
        .map_err(sql("清理请求"))?;
    connection
        .execute("DELETE FROM day WHERE day < ?1", params![before])
        .map_err(sql("清理日账"))?;
    Ok(())
}

/// 顺手查一次请求行数：对账时看「世界说发了多少次」对不对得上。
#[cfg(test)]
pub fn requests(connection: &Connection) -> Result<u64, ApiError> {
    connection
        .query_row("SELECT COUNT(*) FROM request", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(sql("数请求"))
        .map(|count| count as u64)
}

/// 旧版本的 `usage.json`：把日汇总导进来，再把文件改名留底（不再读第二次）。
fn import_json(connection: &Connection, home: &Path) -> Result<(), ApiError> {
    let old = home.join("usage.json");
    if !old.exists() {
        return Ok(());
    }
    let value = crate::storage::read_json(&old).unwrap_or_default();
    if let Some(days) = value["days"].as_object() {
        for (day, agents) in days {
            for (agent, usage) in agents.as_object().into_iter().flatten() {
                let Ok(usage) = serde_json::from_value::<DayUsage>(usage.clone()) else {
                    continue;
                };
                connection
                    .execute(
                        "INSERT OR IGNORE INTO day(
                            day, agent, calls, tokens, input_tokens, cache_hit_tokens,
                            unmetered, estimated, cost_micros, priced, unpriced)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                        params![
                            day,
                            agent,
                            usage.calls as i64,
                            usage.tokens as i64,
                            usage.input_tokens as i64,
                            usage.cache_hit_tokens as i64,
                            usage.unmetered as i64,
                            usage.estimated as i64,
                            usage.cost_micros as i64,
                            usage.priced as i64,
                            usage.unpriced as i64,
                        ],
                    )
                    .map_err(sql("导入旧账"))?;
            }
        }
    }
    let kept = home.join("usage.json.imported");
    std::fs::rename(&old, &kept)
        .map_err(|error| ApiError::new(500, format!("旧账本导入后没改名：{error}")))?;
    Ok(())
}
