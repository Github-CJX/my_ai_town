//! 这台电脑上的账号：默认管理员、管理员给朋友建号、每个账号一份自己的模型密钥。
//!
//! 账号就是本机的一份档案（Cookie `town_user=<id>`）。每个档案有一个 4–8 位数字密码，
//! 第一次打开时由用户自己建管理员账号（名字 + 密码），管理员再给朋友建号。
//! 密码挡住的是「同一个屏幕上顺手切过去」；它挡不住能读到数据目录的人——本机形态里
//! 密钥文件本来就在那儿。真正的身份凭据留给远程/邀请形态（手册 WP-03）。
use crate::error::ApiError;
use crate::storage::{read_json, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 账号 Cookie 的名字。管理员建号后直接换到新账号，用的也是它。
pub const USER_COOKIE: &str = "town_user";
/// 这台电脑最多几个账号（一个人、几个朋友；再多不如各用各的电脑）
pub const MAX_USERS: usize = 8;
/// 名字最多几个字
pub const MAX_NAME: usize = 16;
/// 密码存成「盐 + 迭代摘要」时迭代多少轮。与 scripts/towns/accounts.mjs 必须一致：
/// 同一个 accounts.json 两边都要能读出对方的账号。
const PIN_ROUNDS: u32 = 20_000;

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
    /// 那个化身在小镇里的名字（改过名也跟着变）：下次进场直接用它，不再改名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_name: Option<String>,
    /// 还能自己建几个公共 Agent：管理员不限（None），普通账号 1 个
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_limit: Option<u32>,
    /// 建号时间（毫秒）
    pub created_at: u64,
    /// 密码的「盐:摘要」（见 seal_pin）：有这个字段才叫「锁着」，切换时要输密码
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<String>,
}

impl User {
    /// 发给页面看的字段：不包含任何密钥，也不包含密码摘要
    pub fn public(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "avatar_id": self.avatar_id,
            "avatar_name": self.avatar_name,
            "agent_limit": self.agent_limit,
            "locked": self.pin.is_some(),
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// 盐 + 两万轮摘要。算法必须与 scripts/towns/accounts.mjs 的 digest 一字不差，
/// 否则同一个 accounts.json 两边读出来的密码对不上。
fn pin_digest(salt: &str, pin: &str) -> String {
    let mut hash = sha_hex(&format!("{salt}:{pin}"));
    for _ in 0..PIN_ROUNDS {
        hash = sha_hex(&format!("{hash}{salt}"));
    }
    hash
}

fn seal_pin(pin: &str) -> String {
    let salt = crate::token()[..16].to_owned();
    format!("{salt}:{}", pin_digest(&salt, pin))
}

fn pin_matches(sealed: &str, pin: &str) -> bool {
    match sealed.split_once(':') {
        Some((salt, hash)) => pin_digest(salt, pin) == hash,
        None => false,
    }
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

fn check_pin(pin: &str) -> Result<(), ApiError> {
    let digits = pin.chars().count();
    if !(4..=8).contains(&digits) || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::bad("密码是 4–8 位数字"));
    }
    Ok(())
}

/// 一个账号自己的模型服务：服务商、模型、端点、密钥。
/// 密钥只在 管理服务→世界 方向出现（世界只记内存，不落盘、不回读）；管理员的这份就是小镇的密钥。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiAccount {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
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
        write_json(&self.path(), &json!({ "version": 1, "users": self.users }))
    }

    pub fn list(&self) -> &[User] {
        &self.users
    }

    pub fn find(&self, id: &str) -> Option<&User> {
        self.users.iter().find(|u| u.id == id)
    }

    /// 默认管理员：账号表里那个管理员账号（永远是第一个）。
    pub fn admin(&self) -> Option<User> {
        self.users.iter().find(|u| u.role == Role::Admin).cloned()
    }

    /// 还没建管理员（第一次启动）：页面要先把「创建你的账号」摆出来。
    pub fn needs_setup(&self) -> bool {
        self.admin().is_some_and(|u| u.pin.is_none())
    }

    /// 这次请求是谁：只认带过来的 Cookie。还没建号、还没选号时谁也不算——
    /// 页面得先建一个账号，别的接口也要等那一步。
    pub fn current(&self, cookie: Option<&str>) -> Option<User> {
        cookie.and_then(|id| self.find(id)).cloned()
    }

    fn make(&self, name: &str, role: Role, agent_limit: Option<u32>) -> User {
        User {
            id: format!("u{}", &crate::token()[..16]),
            name: name.to_owned(),
            role,
            avatar_id: None,
            avatar_name: None,
            agent_limit,
            created_at: now(),
            pin: None,
        }
    }

    /// 第一次打开时由用户自己建管理员账号：名字 + 密码。已经建过就拒绝。
    pub fn setup(&mut self, name: &str, pin: &str) -> Result<User, ApiError> {
        if !self.needs_setup() {
            return Err(ApiError::bad("管理员账号已经建好了"));
        }
        let name = check_name(name)?;
        check_pin(pin)?;
        let admin = self
            .users
            .iter_mut()
            .find(|u| u.role == Role::Admin)
            .expect("账号表里总有管理员");
        admin.name = name;
        admin.pin = Some(seal_pin(pin));
        let admin = admin.clone();
        self.save()?;
        Ok(admin)
    }

    /// 管理员给朋友建号：名字 + 一个初始密码（朋友以后可以自己换）。
    /// 名字是进镇后看到的名字，重名会分不清，所以不许重名。
    pub fn create(&mut self, name: &str, pin: &str) -> Result<User, ApiError> {
        let name = check_name(name)?;
        check_pin(pin)?;
        if self.users.iter().any(|u| u.name == name) {
            return Err(ApiError::bad("已经有同名的账号"));
        }
        if self.users.len() >= MAX_USERS {
            return Err(ApiError::bad(format!("这台电脑最多 {MAX_USERS} 个账号")));
        }
        let mut user = self.make(&name, Role::Member, Some(1));
        user.pin = Some(seal_pin(pin));
        self.users.push(user.clone());
        self.save()?;
        Ok(user)
    }

    /// 换密码：原来的密码对得上才换；既有的密码不能靠「不知道旧密码」改掉。
    pub fn set_pin(
        &mut self,
        id: &str,
        current: Option<&str>,
        pin: Option<&str>,
    ) -> Result<User, ApiError> {
        let index = self
            .users
            .iter()
            .position(|u| u.id == id)
            .ok_or_else(|| ApiError::bad("没有这个账号"))?;
        if let Some(sealed) = self.users[index].pin.clone() {
            match current {
                Some(current) if pin_matches(&sealed, current) => {}
                _ => return Err(ApiError::new(403, "原来的密码不对")),
            }
        }
        let sealed = match pin {
            Some(pin) => {
                check_pin(pin)?;
                Some(seal_pin(pin))
            }
            None => return Err(ApiError::bad("新密码是 4–8 位数字")),
        };
        self.users[index].pin = sealed;
        let user = self.users[index].clone();
        self.save()?;
        Ok(user)
    }

    /// 切到某个账号：锁着的账号要密码。
    pub fn select(&self, id: &str, pin: Option<&str>) -> Result<User, ApiError> {
        let user = self.find(id).ok_or_else(|| ApiError::bad("没有这个账号"))?;
        if let Some(sealed) = &user.pin {
            match pin {
                Some(pin) if pin_matches(sealed, pin) => {}
                Some(_) => return Err(ApiError::new(403, "密码不对")),
                None => return Err(ApiError::new(403, "这个账号要密码")),
            }
        }
        Ok(user.clone())
    }

    /// 记下这个账号在小镇里的固定化身（页面上第一次进化身、改名之后各记一次）。
    /// 传 None 就解开绑定，下次进镇当新人。编号和名字都由页面上报：本机形态下没有口令，
    /// 谁能开页面谁就能切档案，这一条是「一个账号一个化身」的记性，不是授权。
    pub fn set_avatar(
        &mut self,
        id: &str,
        avatar: Option<(String, String)>,
    ) -> Result<User, ApiError> {
        if let Some((avatar_id, avatar_name)) = &avatar {
            let bad = avatar_id.chars().count() > 64
                || avatar_id.is_empty()
                || avatar_id
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace());
            if bad {
                return Err(ApiError::bad("化身编号不合法"));
            }
            if avatar_name.chars().count() > MAX_NAME {
                return Err(ApiError::bad(format!("化身名字最多 {MAX_NAME} 个字")));
            }
        }
        let user = self
            .users
            .iter_mut()
            .find(|u| u.id == id)
            .ok_or_else(|| ApiError::bad("没有这个账号"))?;
        user.avatar_id = avatar.as_ref().map(|(id, _)| id.clone());
        user.avatar_name = avatar.map(|(_, name)| name);
        let user = user.clone();
        self.save()?;
        Ok(user)
    }

    /// 这个账号自己的目录（users/<id>）：agent 定义这类只属于这个账号的东西放在这里。
    pub fn home(&self, id: &str) -> PathBuf {
        self.root.join("users").join(id)
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

    /// 这个账号自己选定的模型与密钥：投放他的 agent 时随人一起交给世界（世界只记内存）。
    /// 管理员用的就是小镇那份配置，也就是「世界自己的密钥」；普通账号是 users/<id>/config 那份，
    /// 密钥从空开始，得他自己在「设定 · 账号」里填。没选模型或没填密钥回 None——
    /// 照样能投，只是那名村民会先在镇上等着。
    pub fn api(&self, base: &Path, user: &User) -> Result<Option<ApiAccount>, ApiError> {
        let application = self.config(base, user)?;
        let doc = read_json(&application)?;
        let providers_path = doc["providers_path"].as_str().unwrap_or_default();
        let credentials_path = doc["credentials_path"].as_str().unwrap_or_default();
        let providers = read_json(Path::new(providers_path)).unwrap_or_else(|_| json!({}));
        let provider = providers["active"]["provider"].as_str().unwrap_or_default();
        let model = providers["active"]["model"].as_str().unwrap_or_default();
        if provider.is_empty() || model.is_empty() {
            return Ok(None);
        }
        let credentials = read_json(Path::new(credentials_path)).unwrap_or_else(|_| json!({}));
        let api_key = credentials[provider].as_str().unwrap_or_default();
        if api_key.trim().is_empty() {
            return Ok(None);
        }
        let base_url = providers["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|entry| entry["id"] == provider)
            .and_then(|entry| entry["base_url"].as_str())
            .unwrap_or_default()
            .to_owned();
        Ok(Some(ApiAccount {
            provider: provider.to_owned(),
            model: model.to_owned(),
            base_url,
            api_key: api_key.to_owned(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("town-accounts-{}", crate::token()));
        std::fs::create_dir_all(&root).expect("建临时目录");
        root
    }

    /// 一个账号一个固定化身：记下来、重启之后还在、传 null 能解开
    #[test]
    fn an_account_keeps_one_avatar_across_restarts() {
        let root = temp_root();
        let mut accounts = Accounts::load(&root).expect("建账号表");
        let admin = accounts.admin().expect("账号表里总有管理员");
        assert_eq!(admin.avatar_id, None);
        for bad in ["", " player_avatar", &"a".repeat(65)] {
            assert!(
                accounts
                    .set_avatar(&admin.id, Some((bad.to_owned(), "阿岚".into())))
                    .is_err(),
                "{bad:?} 不该收"
            );
        }
        assert!(accounts
            .set_avatar(&admin.id, Some(("player_avatar".into(), "阿".repeat(17))))
            .is_err());
        assert!(accounts
            .set_avatar("u-nobody", Some(("player_avatar".into(), "阿岚".into())))
            .is_err());
        let user = accounts
            .set_avatar(&admin.id, Some(("player_avatar".into(), "阿岚".into())))
            .expect("记下化身");
        assert_eq!(user.avatar_id.as_deref(), Some("player_avatar"));
        assert_eq!(user.avatar_name.as_deref(), Some("阿岚"));
        // 重开管理服务：档案里还记着这个人
        let reloaded = Accounts::load(&root).expect("重读账号表");
        assert_eq!(
            reloaded
                .find(&admin.id)
                .and_then(|u| u.avatar_name.as_deref()),
            Some("阿岚")
        );
        assert_eq!(
            accounts
                .set_avatar(&admin.id, None)
                .expect("解开")
                .avatar_id,
            None
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// 投放用的模型与密钥是这个账号自己的：管理员那份就是小镇的，普通账号从空开始、填了才有
    #[test]
    fn an_account_deploys_with_its_own_model_and_key() {
        let root = temp_root();
        let base = root.join("application.json");
        write_json(
            &base,
            &json!({
                "providers_path": root.join("providers.json").to_string_lossy(),
                "credentials_path": root.join("credentials.json").to_string_lossy(),
            }),
        )
        .expect("写应用配置");
        write_json(
            &root.join("providers.json"),
            &json!({
                "active": { "provider": "deepseek", "model": "deepseek-chat" },
                "providers": [{ "id": "deepseek", "base_url": "https://api.deepseek.com" }],
            }),
        )
        .expect("写服务商");
        write_json(
            &root.join("credentials.json"),
            &json!({ "deepseek": "sk-world" }),
        )
        .expect("写密钥");

        let mut accounts = Accounts::load(&root).expect("建账号表");
        accounts.setup("管理员", "2468").expect("建管理员");
        let admin = accounts.admin().expect("账号表里总有管理员");
        let world = accounts.api(&base, &admin).expect("读管理员配置");
        assert_eq!(
            world,
            Some(ApiAccount {
                provider: "deepseek".into(),
                model: "deepseek-chat".into(),
                base_url: "https://api.deepseek.com".into(),
                api_key: "sk-world".into(),
            }),
            "管理员投放用的是小镇那份密钥"
        );

        let friend = accounts.create("朋友", "1357").expect("建普通账号");
        assert_eq!(
            accounts.api(&base, &friend).expect("读普通账号配置"),
            None,
            "普通账号的密钥从空开始"
        );
        let file = accounts.config(&base, &friend).expect("账号自己的配置");
        let doc = read_json(&file).expect("读账号配置");
        let providers_path = PathBuf::from(doc["providers_path"].as_str().unwrap_or_default());
        let credentials_path = PathBuf::from(doc["credentials_path"].as_str().unwrap_or_default());
        let mut providers = read_json(&providers_path).expect("读账号服务商");
        providers["active"] = json!({ "provider": "moonshot", "model": "kimi-k2" });
        providers["providers"] =
            json!([{ "id": "moonshot", "base_url": "https://api.moonshot.cn" }]);
        write_json(&providers_path, &providers).expect("写账号服务商");
        write_json(&credentials_path, &json!({ "moonshot": "sk-friend" })).expect("写账号密钥");
        assert_eq!(
            accounts.api(&base, &friend).expect("再读普通账号配置"),
            Some(ApiAccount {
                provider: "moonshot".into(),
                model: "kimi-k2".into(),
                base_url: "https://api.moonshot.cn".into(),
                api_key: "sk-friend".into(),
            }),
            "他自己填的那份才算数"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// 第一次打开自己建管理员：建完要密码，密码不对切不过去，档案里也不存明文
    #[test]
    fn the_first_run_creates_the_admin_with_a_pin() {
        let root = temp_root();
        let mut accounts = Accounts::load(&root).expect("建账号表");
        assert!(accounts.needs_setup());
        for pin in ["123", "123456789", "abcd", "12 34"] {
            assert!(accounts.setup("阿岚", pin).is_err(), "{pin:?} 不该收");
        }
        let admin = accounts.setup("阿岚", "2468").expect("建管理员");
        assert_eq!(admin.name, "阿岚");
        assert!(admin.public()["locked"].as_bool().unwrap());
        assert!(!accounts.needs_setup());
        assert!(accounts.setup("别人", "1357").is_err(), "建过就不许再建");
        // 建完之后不带 Cookie 就不算任何人：页面得先选账号
        assert!(accounts.current(None).is_none());
        assert!(accounts.select(&admin.id, None).is_err());
        assert!(accounts.select(&admin.id, Some("0000")).is_err());
        assert!(accounts.select(&admin.id, Some("2468")).is_ok());
        // 朋友的号也要密码，改名换密码要验旧密码
        assert!(accounts.create("阿树", "12").is_err());
        let friend = accounts.create("阿树", "1357").expect("建号");
        assert!(accounts.select(&friend.id, Some("2468")).is_err());
        assert!(accounts
            .set_pin(&friend.id, Some("2468"), Some("9876"))
            .is_err());
        assert!(accounts
            .set_pin(&friend.id, Some("1357"), Some("9876"))
            .is_ok());
        assert!(accounts.select(&friend.id, Some("9876")).is_ok());
        // 重开管理服务：密码还在，而且存的不是明文
        let reloaded = Accounts::load(&root).expect("重读账号表");
        assert!(reloaded.select(&admin.id, Some("2468")).is_ok());
        let saved = std::fs::read_to_string(root.join("accounts.json")).expect("读档案");
        assert!(!saved.contains("2468"), "档案里不该有明文密码");
        std::fs::remove_dir_all(&root).ok();
    }
}
