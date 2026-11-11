//! 账号自己的用量与额度：世界按居民记用量，管理服务把居民换回账号的 agent 再汇总。
//!
//! 额度也住在账号目录（`budget.json`）：限定这个账号投出去的每位居民每天的调用数与 token 数，
//! 由世界按居民执行（`set_resident_budget`）。两项都可以空着，空着的那项就沿用世界的全镇额度。
use crate::agents::{self, Agent};
use crate::error::ApiError;
use crate::hosts::Hosts;
use crate::storage::{self, Storage};
use agent::budget::DailyBudget;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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

/// 存下来。两项都可以不带（= 回到全镇额度），但给了就不能是 0。
pub fn save(home: &Path, request: &Value) -> Result<DailyBudget, ApiError> {
    let budget = DailyBudget {
        calls_per_day: number(request, "calls_per_day")?,
        tokens_per_day: number(request, "tokens_per_day")?,
    };
    if budget.calls_per_day == Some(0) {
        return Err(ApiError::bad("每日调用上限须大于 0"));
    }
    if budget.tokens_per_day == Some(0) {
        return Err(ApiError::bad("每日 token 上限须大于 0"));
    }
    let value = serde_json::to_value(&budget).map_err(|_| ApiError::bad("额度存不下来"))?;
    storage::write_json(&file(home), &value)?;
    Ok(budget)
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
        });
        if let Some(calls) = budget.calls_per_day {
            command["calls_per_day"] = json!(calls);
        }
        if let Some(tokens) = budget.tokens_per_day {
            command["tokens_per_day"] = json!(tokens);
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

/// 这个账号今天用了多少：把每个镇里自己那几位居民的用量加起来。
/// 只算已经投出去的居民——定义还在手里的时候不花任何人的钱。
pub fn summary(hosts: &Hosts, storage: &Storage, home: &Path) -> Result<Value, ApiError> {
    let agents = agents::list(home)?;
    let budget = read(home);
    let mut towns: BTreeMap<String, Option<Value>> = BTreeMap::new();
    let mut rows = Vec::new();
    let (mut calls, mut tokens, mut unmetered) = (0u64, 0u64, 0u64);
    for agent in &agents {
        for (town, here) in &agent.deployed {
            let usage = towns.entry(town.clone()).or_insert_with(|| {
                if !hosts.is_running(town) {
                    return None;
                }
                hosts
                    .query(town, Some(&json!({ "type": "get_usage" })), |msg| {
                        msg["type"] == "usage"
                    })
                    .ok()
            });
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
            }));
        }
    }
    Ok(json!({
        "budget": budget,
        "totals": { "calls": calls, "tokens": tokens, "unmetered": unmetered },
        "agents": rows,
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
        // 0 等于「永远不许跑」，当错误收下，而不是悄悄当成不限
        let zero = save(&home, &json!({ "calls_per_day": 0 })).expect_err("0 不收");
        assert!(zero.message.contains("大于 0"));
        assert_eq!(read(&home), saved);
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
    }
}
