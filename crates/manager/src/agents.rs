//! 账号自己的 agent：定义放在账号目录里（users/<账号>/agents/<编号>.json），换小镇还能用；
//! 投进哪个小镇由人在首页点一下，那一段记忆只留在那个镇的存档里。
//!
//! 格式与 scripts/towns/agents.mjs 一字不差：同一个数据目录，Node 版和 Rust 版要能读对方的文件。
use crate::error::ApiError;
use crate::storage::{read_json, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 名字最多几个字（和 accounts 的账号名一样长）
pub const MAX_NAME: usize = 16;
/// 模板编号最长多少字符（世界给的模板编号就是这个量级）
const MAX_TEMPLATE: usize = 200;
/// 落脚点的地名最长多少字符
const MAX_HOME: usize = 64;

/// 投进某个小镇之后记下的一笔：镇上给的居民编号、当时叫的名字、什么时候投的
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Deployed {
    pub resident: String,
    pub name: String,
    pub at: u64,
}

/// 一份 agent 定义。`deployed` 以小镇编号为键：同一个定义在几个小镇各有一个自己。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub template_id: String,
    #[serde(default)]
    pub template_version: u32,
    /// 想住的落脚点；那个小镇没有这个地方时就按世界自己安排
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    /// 建的时间（毫秒）：列表按它排
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub deployed: BTreeMap<String, Deployed>,
}

impl Agent {
    /// 发给页面看的：投放记录摊成一张表，页面上按小镇逐条显示
    pub fn public(&self) -> Value {
        let deployed: Vec<Value> = self
            .deployed
            .iter()
            .map(|(town, record)| {
                json!({
                    "town": town,
                    "resident": record.resident,
                    "name": record.name,
                    "at": record.at,
                })
            })
            .collect();
        json!({
            "id": self.id,
            "name": self.name,
            "template_id": self.template_id,
            "template_version": self.template_version,
            "home": self.home,
            "created_at": self.created_at,
            "deployed": deployed,
        })
    }

    pub fn deployed_in(&self, town: &str) -> Option<&Deployed> {
        self.deployed.get(town)
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 账号目录下的 agents 目录
pub fn dir(home: &Path) -> PathBuf {
    home.join("agents")
}

fn file(home: &Path, id: &str) -> Result<PathBuf, ApiError> {
    if id.is_empty()
        || id
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '.' | ':'))
    {
        return Err(ApiError::bad("agent 编号不合法"));
    }
    Ok(dir(home).join(format!("{id}.json")))
}

/// 这个账号的全部定义；坏掉的文件跳过（一个文件坏了不该让整张列表打不开）
pub fn list(home: &Path) -> Result<Vec<Agent>, ApiError> {
    let dir = dir(home);
    let mut agents = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(agents),
        Err(error) => return Err(error.into()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(agent) = read_json(&path).and_then(|value| {
            serde_json::from_value::<Agent>(value)
                .map_err(|e| ApiError::bad(format!("agent 文件无法解析：{e}")))
        }) {
            agents.push(agent);
        }
    }
    agents.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok(agents)
}

pub fn read(home: &Path, id: &str) -> Result<Agent, ApiError> {
    let path = file(home, id)?;
    if !path.exists() {
        return Err(ApiError::new(404, "没有这个 agent"));
    }
    serde_json::from_value(read_json(&path)?)
        .map_err(|e| ApiError::bad(format!("agent 文件无法解析：{e}")))
}

fn check_name(name: &str) -> Result<String, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(ApiError::bad(format!("名字须为 1–{MAX_NAME} 个字")));
    }
    if name.chars().any(char::is_control) {
        return Err(ApiError::bad("名字里有不能用的字符"));
    }
    Ok(name.to_owned())
}

/// 建一个定义：名字（账号内不重名）、模板编号与版本、可选落脚点；普通账号受 limit 限制。
pub fn create(home: &Path, request: &Value, limit: Option<u32>) -> Result<Agent, ApiError> {
    let name = check_name(request["name"].as_str().unwrap_or_default())?;
    let template_id = request["template_id"].as_str().unwrap_or_default().trim();
    if template_id.is_empty() || template_id.chars().count() > MAX_TEMPLATE {
        return Err(ApiError::bad("模板编号不对"));
    }
    let version = request["template_version"]
        .as_u64()
        .ok_or_else(|| ApiError::bad("模板版本不对"))?;
    if version > u32::MAX as u64 {
        return Err(ApiError::bad("模板版本不对"));
    }
    let home_name = match request["home"].as_str() {
        Some(home) if !home.trim().is_empty() => {
            let home = home.trim();
            if home.chars().count() > MAX_HOME {
                return Err(ApiError::bad("落脚点的名字太长"));
            }
            Some(home.to_owned())
        }
        _ => None,
    };
    let agents = list(home)?;
    if agents.iter().any(|agent| agent.name == name) {
        return Err(ApiError::bad("已经有同名的 agent 了"));
    }
    if let Some(limit) = limit {
        if agents.len() >= limit as usize {
            let mut error = ApiError::new(403, format!("这个账号最多 {limit} 个 agent"));
            error.code = Some("limit".into());
            return Err(error);
        }
    }
    let agent = Agent {
        id: format!("a{}", &crate::token()[..16]),
        name,
        template_id: template_id.to_owned(),
        template_version: version as u32,
        home: home_name,
        created_at: now(),
        deployed: BTreeMap::new(),
    };
    save(home, &agent)?;
    Ok(agent)
}

fn save(home: &Path, agent: &Agent) -> Result<(), ApiError> {
    std::fs::create_dir_all(dir(home))?;
    write_json(
        &file(home, &agent.id)?,
        &serde_json::to_value(agent).map_err(|e| ApiError::bad(e.to_string()))?,
    )
}

/// 投放成功之后记一笔：哪个小镇、镇上给的居民编号、当时叫的名字
pub fn record_deploy(
    home: &Path,
    agent: &mut Agent,
    town: &str,
    resident: &str,
    name: &str,
) -> Result<(), ApiError> {
    agent.deployed.insert(
        town.to_owned(),
        Deployed {
            resident: resident.to_owned(),
            name: name.to_owned(),
            at: now(),
        },
    );
    save(home, agent)
}

/// 删一个定义：还投在某个小镇里的删不掉（记录和镇上的人得对得上）
pub fn remove(home: &Path, id: &str) -> Result<(), ApiError> {
    let agent = read(home, id)?;
    if let Some((town, record)) = agent.deployed.iter().next() {
        return Err(ApiError::new(
            409,
            format!("这个 agent 还在「{town}」里（{}），删不掉", record.name),
        ));
    }
    std::fs::remove_file(file(home, id)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        let home = std::env::temp_dir().join(format!("town-agents-{}", crate::token()));
        std::fs::create_dir_all(&home).expect("建临时目录");
        home
    }

    fn make(home: &Path, name: &str, limit: Option<u32>) -> Result<Agent, ApiError> {
        create(
            home,
            &json!({ "name": name, "template_id": "t1", "template_version": 1 }),
            limit,
        )
    }

    /// 定义存在账号目录里、重名不收、普通账号受上限、投出去的删不掉
    #[test]
    fn an_account_keeps_its_agents_and_the_deployed_one_stays() {
        let home = temp_home();
        assert!(list(&home).expect("空目录").is_empty());
        let mut first = make(&home, "阿岚", Some(1)).expect("建第一个");
        assert_eq!(first.name, "阿岚");
        assert!(first.deployed_in("town-1").is_none());
        // 同名不收
        assert!(make(&home, "阿岚", None).is_err());
        // 普通账号就到上限
        let full = make(&home, "阿树", Some(1)).expect_err("超过上限");
        assert_eq!(full.status, 403);
        assert_eq!(full.code.as_deref(), Some("limit"));
        // 投出去之后有记录，并且删不掉
        record_deploy(&home, &mut first, "town-1", "r1", "阿岚").expect("记一笔");
        let saved = read(&home, &first.id).expect("读回来");
        assert_eq!(
            saved.deployed_in("town-1").map(|d| d.resident.as_str()),
            Some("r1")
        );
        assert_eq!(saved.public()["deployed"][0]["town"], "town-1");
        let stuck = remove(&home, &first.id).expect_err("投出去的不让删");
        assert_eq!(stuck.status, 409);
        // 空着的定义可以删
        let spare = make(&home, "阿树", None).expect("再建一个");
        remove(&home, &spare.id).expect("删掉");
        assert_eq!(list(&home).expect("列表").len(), 1);
        // 编号里不能带路径
        assert!(read(&home, "../accounts").is_err());
    }
}
