//! 账号自己的用量与额度：世界按居民记用量，管理服务把居民换回账号的 agent 再汇总。
//!
//! 额度也住在账号目录（`budget.json`）：限定这个账号投出去的每位居民每天的调用数与 token 数，
//! 由世界按居民执行（`set_resident_budget`）。两项都可以空着，空着的那项就沿用世界的全镇额度。
//!
//! 世界那边的台账只留最近若干条，日计数过一天就归零；所以账号这边另记一本跨天的账
//! （`usage.json`）：逐日逐人累加，请求号去重，过几天再清掉旧的。
use crate::agents::{self, Agent};
use crate::error::ApiError;
use crate::hosts::Hosts;
use crate::storage::{self, Storage};
use agent::budget::DailyBudget;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 账号自己的每日额度存这里；两项都空 = 各用世界的全镇额度。
pub fn file(home: &Path) -> PathBuf {
    home.join("budget.json")
}

/// 读账号的额度；文件不在或读坏了就当没设过（全员用世界的全镇额度）。
pub fn read(home: &Path) -> DailyBudget {
    storage::read_json(&file(home))
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

/// 存下来。两项都可以不带（= 回到全镇额度），但给了就不能是 0；并发与速率同理。
pub fn save(home: &Path, request: &Value) -> Result<DailyBudget, ApiError> {
    let budget = DailyBudget {
        calls_per_day: number(request, "calls_per_day")?,
        tokens_per_day: number(request, "tokens_per_day")?,
        group: None,
        max_concurrent: small(request, "max_concurrent")?,
        per_minute: small(request, "per_minute")?,
    };
    if budget.calls_per_day == Some(0) {
        return Err(ApiError::bad("每日调用上限须大于 0"));
    }
    if budget.tokens_per_day == Some(0) {
        return Err(ApiError::bad("每日 token 上限须大于 0"));
    }
    // 并发与速率按范围校验；组标签由推送时按账号补上，所以这里拿个占位标签探一下。
    let probe = DailyBudget {
        group: Some("acct".into()),
        ..budget.clone()
    };
    probe.validate_quota().map_err(ApiError::bad)?;
    let value = serde_json::to_value(&budget).map_err(|_| ApiError::bad("额度存不下来"))?;
    storage::write_json(&file(home), &value)?;
    Ok(budget)
}

/// 世界不认识账号，只认「组标签」：同一个账号的 agent 共用一组并发与速率。
pub fn group_of(owner: &str) -> String {
    format!("acct-{owner}")
}

/// 并发与速率这类小整数。
fn small(request: &Value, key: &str) -> Result<Option<u32>, ApiError> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| ApiError::bad(format!("{key} 须是不小于 1 的整数"))),
        Some(_) => Err(ApiError::bad(format!("{key} 须是不小于 1 的整数"))),
    }
}

fn number(request: &Value, key: &str) -> Result<Option<u64>, ApiError> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| ApiError::bad(format!("{key} 须是不小于 0 的整数"))),
        Some(_) => Err(ApiError::bad(format!("{key} 须是不小于 0 的整数"))),
    }
}

/// 把账号的额度发给正在跑的小镇：一位居民发一条，世界按居民执行。
/// 没在跑的小镇跳过——等它下次起来，投放/心跳会再发一次。
pub fn push(
    hosts: &Hosts,
    town: &str,
    agents: &[Agent],
    budget: &DailyBudget,
    owner: &str,
) -> Result<(), ApiError> {
    if !hosts.is_running(town) {
        return Ok(());
    }
    for agent in agents {
        let Some(here) = agent.deployed_in(town) else {
            continue;
        };
        let request_id = format!("budget-{}-{}", agent.id, crate::token());
        let mut command = json!({
            "type": "set_resident_budget",
            "request_id": request_id,
            "resident": here.resident,
            "group": group_of(owner),
        });
        if let Some(calls) = budget.calls_per_day {
            command["calls_per_day"] = json!(calls);
        }
        if let Some(tokens) = budget.tokens_per_day {
            command["tokens_per_day"] = json!(tokens);
        }
        if let Some(cap) = budget.max_concurrent {
            command["max_concurrent"] = json!(cap);
        }
        if let Some(cap) = budget.per_minute {
            command["per_minute"] = json!(cap);
        }
        let want = request_id.clone();
        let reply = hosts.query(town, Some(&command), move |msg| {
            msg["type"] == "resident_budget_saved" && msg["request_id"] == want
        })?;
        if reply["ok"] != json!(true) {
            return Err(ApiError::new(
                409,
                reply["message"]
                    .as_str()
                    .unwrap_or("镇上没接受这个额度，稍后再试"),
            ));
        }
    }
    Ok(())
}

/// 账号的跨天账本存这里：逐日逐人，请求号去重。
pub fn ledger_file(home: &Path) -> PathBuf {
    home.join("usage.json")
}

/// 一天一个人的用量。`tokens` 只算服务商报回来的；没报回来的那几次记在 `unmetered`，
/// 预留的估算值记在 `estimated`——「不知道」留在另一栏，不混进真花掉的钱。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DayUsage {
    #[serde(default)]
    pub calls: u64,
    #[serde(default)]
    pub tokens: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub cache_hit_tokens: u64,
    #[serde(default)]
    pub unmetered: u64,
    #[serde(default)]
    pub estimated: u64,
    /// 花掉的钱（微元 = 元 × 1 000 000）：只算有价目表的模型。
    #[serde(default)]
    pub cost_micros: u64,
    /// 有计量、也有价钱，算进去了的请求数。
    #[serde(default)]
    pub priced: u64,
    /// 有计量但价目表里没有这个模型：钱不知道，不写成 0。
    #[serde(default)]
    pub unpriced: u64,
}

/// 逐日逐人的账本，外加已经折进去的请求号（折过就不再重复计）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    #[serde(default)]
    pub days: BTreeMap<String, BTreeMap<String, DayUsage>>,
    /// 请求号 → 发出时间（Unix 秒）。请求序号在世界重启后会从头来，所以号里带着镇、居民与发出时间。
    #[serde(default)]
    pub seen: BTreeMap<String, u64>,
}

pub fn read_ledger(home: &Path) -> Ledger {
    storage::read_json(&ledger_file(home))
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn save_ledger(home: &Path, ledger: &Ledger) -> Result<(), ApiError> {
    let value = serde_json::to_value(ledger).map_err(|_| ApiError::bad("账本存不下来"))?;
    storage::write_json(&ledger_file(home), &value)
}

fn usage_of(hosts: &Hosts, town: &str) -> Option<Value> {
    if !hosts.is_running(town) {
        return None;
    }
    hosts
        .query(town, Some(&json!({ "type": "get_usage" })), |msg| {
            msg["type"] == "usage"
        })
        .ok()
}

/// 把世界这次的请求台账折进跨天账本：按请求号去重，还在路上的等它落定。
/// `owners` 是 居民 → (agent 编号, agent 名字)，不是自己投的那几位不记。
fn fold(
    ledger: &mut Ledger,
    town: &str,
    usage: &Value,
    owners: &BTreeMap<String, (String, String)>,
    prices: &crate::prices::Table,
) {
    let now = unix_now();
    for request in usage["requests"].as_array().into_iter().flatten() {
        let Some(resident) = request["resident_id"].as_str() else {
            continue;
        };
        let Some((agent_id, _)) = owners.get(resident) else {
            continue;
        };
        // 还在路上的不算：等它落定，下一次折账本时再计一次（旧存档里的中文值也认）
        let status = request["status"].as_str().unwrap_or("");
        if status == "in_flight" || status == "进行中" {
            continue;
        }
        let sent_at = number_of(&request["sent_at"]);
        let at = if sent_at == 0 { now } else { sent_at };
        let key = format!("{town}/{resident}/{at}/{}", number_of(&request["id"]));
        if ledger.seen.contains_key(&key) {
            continue;
        }
        ledger.seen.insert(key, at);
        let here = ledger
            .days
            .entry(utc_day(at))
            .or_default()
            .entry(agent_id.clone())
            .or_default();
        here.calls += 1;
        let input = request["input_tokens"].as_u64();
        let output = request["output_tokens"].as_u64();
        if input.is_some() || output.is_some() {
            let input = input.unwrap_or(0);
            let output = output.unwrap_or(0);
            let cache = number_of(&request["cache_hit_tokens"]);
            here.tokens += input + output;
            here.input_tokens += input;
            here.cache_hit_tokens += cache;
            match prices.cost_micros(request["model"].as_str(), input, cache, output) {
                Some(cost) => {
                    here.cost_micros += cost;
                    here.priced += 1;
                }
                // 有计量、没价钱：记下来，不折算成 0
                None => here.unpriced += 1,
            }
        } else {
            here.unmetered += 1;
            here.estimated += number_of(&request["reserved_tokens"]);
        }
    }
}

/// 留 30 天的日账、8 天的请求号：再旧的世界那边也早看不到了。
fn prune(ledger: &mut Ledger, now: u64) {
    let keep_days = utc_day(now.saturating_sub(30 * 86_400));
    ledger
        .days
        .retain(|day, _| day.as_str() >= keep_days.as_str());
    let keep_after = now.saturating_sub(8 * 86_400);
    ledger.seen.retain(|_, at| *at >= keep_after);
}

/// 最近几天的账，新的在前。
fn history(ledger: &Ledger, days: usize, names: &BTreeMap<String, String>) -> Value {
    let mut recent: Vec<(&String, &BTreeMap<String, DayUsage>)> = ledger.days.iter().collect();
    recent.sort_by(|left, right| right.0.cmp(left.0));
    let rows: Vec<Value> = recent
        .into_iter()
        .take(days)
        .map(|(day, per_agent)| {
            let mut sums = DayUsage::default();
            let mut agents = Vec::new();
            for (agent_id, here) in per_agent {
                sums.calls += here.calls;
                sums.tokens += here.tokens;
                sums.input_tokens += here.input_tokens;
                sums.cache_hit_tokens += here.cache_hit_tokens;
                sums.unmetered += here.unmetered;
                sums.estimated += here.estimated;
                sums.cost_micros += here.cost_micros;
                sums.priced += here.priced;
                sums.unpriced += here.unpriced;
                agents.push(json!({
                    "agent_id": agent_id,
                    "name": names.get(agent_id).cloned().unwrap_or_else(|| agent_id.clone()),
                    "calls": here.calls,
                    "tokens": here.tokens,
                    "unmetered": here.unmetered,
                    "cost_micros": here.cost_micros,
                }));
            }
            json!({
                "day": day,
                "calls": sums.calls,
                "tokens": sums.tokens,
                "input_tokens": sums.input_tokens,
                "cache_hit_tokens": sums.cache_hit_tokens,
                "unmetered": sums.unmetered,
                "estimated": sums.estimated,
                "cost_micros": sums.cost_micros,
                "priced": sums.priced,
                "unpriced": sums.unpriced,
                "agents": agents,
            })
        })
        .collect();
    Value::Array(rows)
}

/// Unix 秒 → UTC 日期 `YYYY-MM-DD`。不引依赖，就几行历法换算（Howard Hinnant 的 public domain 算法）。
fn utc_day(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 这个账号投出去的居民分别在哪几个镇、那个镇此刻的用量（没在跑就是 `None`）。
type Towns = BTreeMap<String, Option<Value>>;
type Owners = BTreeMap<String, BTreeMap<String, (String, String)>>;

fn gather(hosts: &Hosts, agents: &[Agent]) -> (Towns, Owners) {
    let mut towns = Towns::new();
    let mut owners = Owners::new();
    for agent in agents {
        for (town, here) in &agent.deployed {
            towns
                .entry(town.clone())
                .or_insert_with(|| usage_of(hosts, town));
            owners.entry(town.clone()).or_default().insert(
                here.resident.clone(),
                (agent.id.clone(), agent.name.clone()),
            );
        }
    }
    (towns, owners)
}

/// 把这次拿到的请求台账折进跨天账本，变过才写回去。
fn fold_into(home: &Path, towns: &Towns, owners: &Owners) -> Result<Ledger, ApiError> {
    let mut ledger = read_ledger(home);
    let before = ledger.clone();
    let prices = crate::prices::table(home);
    for (town, usage) in towns {
        if let (Some(usage), Some(by_resident)) = (usage, owners.get(town)) {
            fold(&mut ledger, town, usage, by_resident, &prices);
        }
    }
    prune(&mut ledger, unix_now());
    if ledger != before {
        save_ledger(home, &ledger)?;
    }
    Ok(ledger)
}

/// 心跳里顺手折一次：人不在首页（没有 `GET /usage`）也不会把昨天丢掉。
pub fn fold_towns(hosts: &Hosts, home: &Path) -> Result<(), ApiError> {
    let agents = agents::list(home)?;
    if agents.is_empty() {
        return Ok(());
    }
    let (towns, owners) = gather(hosts, &agents);
    fold_into(home, &towns, &owners)?;
    Ok(())
}

/// 这个账号今天用了多少：把每个镇里自己那几位居民的用量加起来；顺手把今天的请求折进跨天账本。
/// 只算已经投出去的居民——定义还在手里的时候不花任何人的钱。
pub fn summary(hosts: &Hosts, storage: &Storage, home: &Path) -> Result<Value, ApiError> {
    let agents = agents::list(home)?;
    let budget = read(home);
    let (towns, owners) = gather(hosts, &agents);
    // 账本是给「过了今天」看的：世界的日计数会在换天时归零，这里留一份不会丢的
    let ledger = fold_into(home, &towns, &owners)?;
    let names: BTreeMap<String, String> = agents
        .iter()
        .map(|agent| (agent.id.clone(), agent.name.clone()))
        .collect();
    let mut rows = Vec::new();
    let (mut calls, mut tokens, mut unmetered) = (0u64, 0u64, 0u64);
    // 今天花掉的钱只存在账本里（世界的 resident 行只有 token），从今天那一行取
    let today = utc_day(unix_now());
    let today_rows = ledger.days.get(&today);
    let mut cost_micros = 0u64;
    let mut priced = 0u64;
    let mut unpriced = 0u64;
    if let Some(per_agent) = today_rows {
        for here in per_agent.values() {
            cost_micros += here.cost_micros;
            priced += here.priced;
            unpriced += here.unpriced;
        }
    }
    for agent in &agents {
        let money = today_rows.and_then(|per_agent| per_agent.get(&agent.id));
        for (town, here) in &agent.deployed {
            let usage = towns.get(town).cloned().unwrap_or(None);
            let empty = Value::Null;
            let row = usage
                .as_ref()
                .and_then(|usage| {
                    usage["residents"]
                        .as_array()?
                        .iter()
                        .find(|row| row["id"] == here.resident.as_str())
                        .cloned()
                })
                .unwrap_or(empty);
            let mine = usage
                .as_ref()
                .and_then(|usage| usage["requests"].as_array().cloned())
                .unwrap_or_default();
            let unmetered_here = mine
                .iter()
                .filter(|request| {
                    request["resident_id"] == here.resident.as_str()
                        && request["unmetered"] == json!(true)
                })
                .count();
            let (row_calls, row_tokens) = (
                number_of(&row["daily_calls"]),
                number_of(&row["daily_tokens"]),
            );
            calls += row_calls;
            tokens += row_tokens;
            unmetered += unmetered_here as u64;
            rows.push(json!({
                "agent_id": agent.id,
                "name": agent.name,
                "town": town,
                "town_name": storage.name(town),
                "running": usage.is_some(),
                "resident": here.resident,
                "resident_name": here.name,
                "calls": row_calls,
                "tokens": row_tokens,
                "input_tokens": number_of(&row["daily_input_tokens"]),
                "cache_hit_tokens": number_of(&row["daily_cache_hit_tokens"]),
                "replies": number_of(&row["replies"]),
                "in_flight": number_of(&row["in_flight"]),
                "paused": row["paused"].clone(),
                "unmetered": unmetered_here,
                "cost_micros": money.map_or(0, |day| day.cost_micros),
            }));
        }
    }
    Ok(json!({
        "budget": budget,
        "totals": {
            "calls": calls,
            "tokens": tokens,
            "unmetered": unmetered,
            "cost_micros": cost_micros,
            "priced": priced,
            "unpriced": unpriced,
        },
        "agents": rows,
        "history": history(&ledger, 7, &names),
    }))
}

fn number_of(value: &Value) -> u64 {
    value.as_u64().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents;

    fn temp_home() -> PathBuf {
        let home = std::env::temp_dir().join(format!("town-usage-{}", crate::token()));
        std::fs::create_dir_all(&home).expect("建临时目录");
        home
    }

    /// 额度存在账号目录里：0 不收，空着就是回到全镇额度
    #[test]
    fn an_account_can_keep_its_own_daily_budget() {
        let home = temp_home();
        assert_eq!(read(&home), DailyBudget::default());
        let saved = save(
            &home,
            &json!({ "calls_per_day": 40, "tokens_per_day": 300_000 }),
        )
        .expect("存额度");
        assert_eq!(saved.calls_per_day, Some(40));
        assert_eq!(saved.tokens_per_day, Some(300_000));
        assert_eq!(read(&home), saved);
        // 账号级的小名额：并发与速率存得下来，越界当错误收下
        let shared = save(
            &home,
            &json!({ "calls_per_day": 40, "max_concurrent": 2, "per_minute": 20 }),
        )
        .expect("存并发与速率");
        assert_eq!(shared.max_concurrent, Some(2));
        assert_eq!(shared.per_minute, Some(20));
        assert_eq!(read(&home), shared);
        assert!(shared.group.is_none(), "组标签是发的时候才填的");
        assert_eq!(group_of("u1"), "acct-u1");
        let fast = save(&home, &json!({ "per_minute": 601 })).expect_err("601 不收");
        assert!(fast.message.contains("1–600"), "{}", fast.message);
        let many = save(&home, &json!({ "max_concurrent": 17 })).expect_err("17 不收");
        assert!(many.message.contains("1–16"), "{}", many.message);
        assert_eq!(read(&home), shared, "被拒的不改磁盘上的额度");
        // 0 等于「永远不许跑」，当错误收下，而不是悄悄当成不限
        let zero = save(&home, &json!({ "calls_per_day": 0 })).expect_err("0 不收");
        assert!(zero.message.contains("大于 0"));
        assert_eq!(read(&home), shared, "被拒的也不改磁盘上的额度");
        // 不带就是回到全镇额度
        assert_eq!(
            save(&home, &json!({})).expect("清掉"),
            DailyBudget::default()
        );
        assert_eq!(read(&home), DailyBudget::default());
    }

    /// 没在跑的小镇照样出现在用量里，但记 0——不能把「不知道」写成真的没花
    #[test]
    fn usage_lists_the_deployed_ones_even_when_the_town_is_not_running() {
        let home = temp_home();
        let root = temp_home();
        let storage = Storage::new(root.clone(), root);
        let agent =
            agents::create(&home, &json!({ "fields": { "name": "阿岚" } }), None).expect("建定义");
        let mut agent = agent;
        agents::record_deploy(&home, &mut agent, "town-1", "r1", "阿岚").expect("记投放");
        let summary = summary(
            &Hosts::new(
                PathBuf::from("host"),
                PathBuf::from("app"),
                1,
                true,
                "127.0.0.1".into(),
                0,
            ),
            &storage,
            &home,
        )
        .expect("汇总");
        assert_eq!(summary["totals"]["calls"], 0);
        assert_eq!(summary["agents"][0]["running"], false);
        assert_eq!(summary["agents"][0]["resident"], "r1");
        assert_eq!(summary["agents"][0]["town_name"], "town-1");
        assert!(summary["budget"]["calls_per_day"].is_null());
        assert_eq!(summary["history"].as_array().map(Vec::len), Some(0));
    }

    /// 同一条请求折两次只算一次；没报计量那次进 `unmetered`，不写成 0 token；
    /// 有计量没价钱的进 `unpriced`，钱不折算成 0
    #[test]
    fn a_request_is_folded_into_the_ledger_once_and_unmetered_keeps_its_own_column() {
        let home = temp_home();
        let mut ledger = Ledger::default();
        let owners: BTreeMap<String, (String, String)> =
            [("r1".to_string(), ("a1".to_string(), "阿岚".to_string()))]
                .into_iter()
                .collect();
        let usage = json!({
            "requests": [
                { "id": 7, "resident_id": "r1", "status": "adopted", "sent_at": 1_700_000_000u64,
                  "model": "deepseek/deepseek-chat",
                  "input_tokens": 120, "output_tokens": 30, "cache_hit_tokens": 40,
                  "reserved_tokens": 200 },
                { "id": 8, "resident_id": "r1", "status": "failed", "sent_at": 1_700_000_100u64,
                  "reserved_tokens": 150 },
                // 不是自己投的居民
                { "id": 9, "resident_id": "r2", "status": "adopted", "sent_at": 1_700_000_100u64,
                  "input_tokens": 999, "output_tokens": 0 },
                // 还在路上：等落定再算
                { "id": 10, "resident_id": "r1", "status": "in_flight", "sent_at": 1_700_000_200u64 },
                // 有计量、价目表里没有这个模型
                { "id": 11, "resident_id": "r1", "status": "adopted", "sent_at": 1_700_000_300u64,
                  "model": "someone/unknown-model", "input_tokens": 10, "output_tokens": 0 },
            ]
        });
        let prices = crate::prices::table(&home);
        fold(&mut ledger, "town-1", &usage, &owners, &prices);
        fold(&mut ledger, "town-1", &usage, &owners, &prices);
        assert_eq!(ledger.seen.len(), 3, "三条落定的请求各记一次");
        let day = ledger.days.get("2023-11-14").expect("折进请求发出那天");
        let mine = day.get("a1").expect("阿岚那行");
        assert_eq!(mine.calls, 3);
        assert_eq!(mine.tokens, 160, "只算服务商报回来的");
        assert_eq!(mine.input_tokens, 130);
        assert_eq!(mine.cache_hit_tokens, 40);
        assert_eq!(mine.unmetered, 1);
        assert_eq!(mine.estimated, 150, "估算值另放一栏");
        // 120 输入里 40 命中：80 × 2 + 40 × 0.5 + 30 × 8 = 420 微元
        assert_eq!(mine.cost_micros, 420);
        assert_eq!(mine.priced, 1);
        assert_eq!(mine.unpriced, 1);
        assert_eq!(day.len(), 1, "别的居民不进这个账号的账本");

        // 最近几天的视图：新的在前，名字补上
        let names: BTreeMap<String, String> = [("a1".to_string(), "阿岚".to_string())]
            .into_iter()
            .collect();
        let view = history(&ledger, 7, &names);
        assert_eq!(view[0]["day"], "2023-11-14");
        assert_eq!(view[0]["calls"], 3);
        assert_eq!(view[0]["cost_micros"], 420);
        assert_eq!(view[0]["unpriced"], 1);
        assert_eq!(view[0]["agents"][0]["name"], "阿岚");
    }

    /// 留 30 天的日账、8 天的请求号，再旧的就清掉
    #[test]
    fn the_ledger_keeps_only_recent_days_and_recent_request_ids() {
        let mut ledger = Ledger::default();
        let now = 1_700_000_000u64; // 2023-11-14
        ledger.days.insert(
            "2023-10-01".into(),
            BTreeMap::from([("a1".into(), DayUsage::default())]),
        );
        ledger.days.insert(
            "2023-11-13".into(),
            BTreeMap::from([("a1".into(), DayUsage::default())]),
        );
        ledger.seen.insert("old".into(), now - 20 * 86_400);
        ledger.seen.insert("recent".into(), now - 86_400);
        prune(&mut ledger, now);
        assert!(!ledger.days.contains_key("2023-10-01"));
        assert!(ledger.days.contains_key("2023-11-13"));
        assert!(!ledger.seen.contains_key("old"));
        assert!(ledger.seen.contains_key("recent"));
    }

    /// 账本按 UTC 日期分组，和世界那边记的发出时间对得上
    #[test]
    fn a_unix_second_lands_on_the_right_utc_day() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(1_700_000_000), "2023-11-14");
        assert_eq!(utc_day(1_700_000_000 + 86_400), "2023-11-15");
    }
}
