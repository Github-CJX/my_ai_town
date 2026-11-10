//! 这台电脑上的账号：默认管理员、管理员给朋友建号、每个账号一份自己的模型密钥。
//!
//! 账号就是本机的一份档案（Cookie `town_user=<id>`），没有口令：能在这台电脑上开页面的人，
//! 本来就能读到同一个数据目录里的密钥文件，再加一道口令只是假门。远程/邀请形态另开一刀（手册 WP-03）。
use crate::error::ApiError;
use crate::storage::{read_json, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 账号 Cookie 的名字。管理员建号后直接换到新账号，用的也是它。
pub const USER_COOKIE: &str = "town_user";
/// 这台电脑最多几个账号（一个人、几个朋友；再多不如各用各的电脑）
pub const MAX_USERS: usize = 8;
/// 名字最多几个字
pub const MAX_NAME: usize = 16;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// 默认账号：用小镇的公共密钥（管理员配好的那份），可以给朋友建号，自己建的 Agent 不限个数
    Admin,
    /// 被管理员建出来的账号：用自己填的密钥，最多建一个公共 Agent
    Member,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct User {
    pub id: String,
    pub name: String,
    pub role: Role,
    /// 这个账号的固定化身：第一次进小镇时记下，之后只控制它（世界身份那一刀用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_id: Option<String>,
    /// 还能自己建几个公共 Agent：管理员不限（None），普通账号 1 个
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_limit: Option<u32>,
    /// 建号时间（毫秒）
    pub created_at: u64,
}

impl User {
    /// 发给页面看的字段：不包含任何密钥
    pub fn public(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "avatar_id": self.avatar_id,
            "agent_limit": self.agent_limit,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct Saved {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    users: Vec<User>,
}

fn one() -> u32 {
    1
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `accounts.json` 读进内存；第一次启动时建好默认管理员。
pub struct Accounts {
    root: PathBuf,
    users: Vec<User>,
}

impl Accounts {
    pub fn load(root: &Path) -> Result<Self, ApiError> {
        let mut accounts = Self {
            root: root.to_owned(),
            users: Vec::new(),
        };
        let path = accounts.path();
        if path.exists() {
            let saved: Saved = serde_json::from_value(read_json(&path)?)
                .map_err(|e| ApiError::bad(format!("账号文件无法解析：{e}")))?;
            accounts.users = saved.users;
        }
        if !accounts.users.iter().any(|u| u.role == Role::Admin) {
            let user = accounts.make("管理员", Role::Admin, None);
            accounts.users.insert(0, user);
            accounts.save()?;
        }
        Ok(accounts)
    }

    fn path(&self) -> PathBuf {
        self.root.join("accounts.json")
    }

    fn save(&self) -> Result<(), ApiError> {
        write_json(
            &self.path(),
            &json!({ "version": 1, "users": self.users }),
        )
    }

    pub fn list(&self) -> &[User] {
        &self.users
    }

    pub fn find(&self, id: &str) -> Option<&User> {
        self.users.iter().find(|u| u.id == id)
    }

    /// 默认管理员：没带 Cookie（或 Cookie 里的账号已经没了）时的身份，本机第一次打开就是它。
    pub fn admin(&self) -> Option<User> {
        self.users
            .iter()
            .find(|u| u.role == Role::Admin)
            .cloned()
    }

    pub fn current(&self, cookie: Option<&str>) -> User {
        cookie
            .and_then(|id| self.find(id))
            .cloned()
            .or_else(|| self.admin())
            .expect("账号表里总有管理员")
    }

    fn make(&self, name: &str, role: Role, agent_limit: Option<u32>) -> User {
        User {
            id: format!("u{}", &crate::token()[..16]),
            name: name.to_owned(),
            role,
            avatar_id: None,
            agent_limit,
            created_at: now(),
        }
    }

    /// 管理员给朋友建号。名字是进镇后看到的名字，重名会分不清，所以不许重名。
    pub fn create(&mut self, name: &str) -> Result<User, ApiError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > MAX_NAME {
            return Err(ApiError::bad(format!("名字须为 1–{MAX_NAME} 个字")));
        }
        if name.chars().any(char::is_control) {
            return Err(ApiError::bad("名字里有不能用的字符"));
        }
        if self.users.iter().any(|u| u.name == name) {
            return Err(ApiError::bad("已经有同名的账号"));
        }
        if self.users.len() >= MAX_USERS {
            return Err(ApiError::bad(format!("这台电脑最多 {MAX_USERS} 个账号")));
        }
        let user = self.make(name, Role::Member, Some(1));
        self.users.push(user.clone());
        self.save()?;
        Ok(user)
    }

    /// 这个账号该用哪份应用配置：管理员用小镇的公共配置，普通账号用自己目录下的那一份。
    /// 普通账号的服务商名单沿用小镇的，密钥从空开始——他的 Agent 用他自己填的密钥。
    pub fn config(&self, base: &Path, user: &User) -> Result<PathBuf, ApiError> {
        if user.role == Role::Admin {
            return Ok(base.to_owned());
        }
        let dir = self.root.join("users").join(&user.id);
        let config_dir = dir.join("config");
        std::fs::create_dir_all(&config_dir)?;
        let base_doc = read_json(base)?;
        let mut doc = base_doc.clone();
        for field in ["providers_path", "credentials_path"] {
            let source = PathBuf::from(base_doc[field].as_str().unwrap_or_default());
            let name = source
                .file_name()
                .map(|n| n.to_owned())
                .ok_or_else(|| ApiError::bad(format!("应用配置缺少 {field}")))?;
            let dest = config_dir.join(&name);
            if !dest.exists() {
                let value = if field == "credentials_path" {
                    json!({})
                } else {
                    read_json(&source).unwrap_or_else(|_| json!({}))
                };
                write_json(&dest, &value)?;
            }
            doc[field] = Value::from(dest.to_string_lossy().into_owned());
        }
        let path = dir.join("application.json");
        write_json(&path, &doc)?;
        Ok(path)
    }
}
