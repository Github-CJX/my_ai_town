//! 按需启动的世界进程：一个小镇一个 host。与 scripts/towns/hosts.mjs 同构。
use crate::error::ApiError;
use crate::storage::{read_json, Storage};
use crate::ws;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(20);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(15);

struct Record {
    child: Child,
    /// 只握着不写：本进程无论怎样退出，管道关闭，host 读到 EOF 后保存并退出。Windows 上关小镇也靠它。
    #[cfg_attr(unix, allow(dead_code))]
    stdin: Option<ChildStdin>,
    endpoint: String,
    /// 世界口令：页面拿不到，只用来签票（见 host::ticket）
    token: String,
    /// 最近一次有人进这个小镇的时间：跑满了先关最久没进过的
    used: Instant,
    /// 最近一次打开的凭证：每次打开都换一个，关闭时拿它核对，刷新后旧页面晚到的关闭就不算数
    lease: String,
}

pub struct Hosts {
    pub host_bin: PathBuf,
    /// 世界进程的工作目录（应用自带数据）。
    pub app: PathBuf,
    pub max_running: usize,
    pub mock_llm: bool,
    /// 传给世界进程的监听地址：只在本机用时是 127.0.0.1，放到服务器上时是 0.0.0.0
    host_bind: String,
    /// 世界的端口：0 是每次随机；放到服务器上时固定一个，防火墙只开这一个
    host_port: u16,
    running: Mutex<HashMap<String, Record>>,
    /// 后台常驻的小镇：不算进「同时运行几个」的名额，也不会被挤掉
    resident: Mutex<Option<String>>,
}

fn alive(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

impl Hosts {
    pub fn new(
        host_bin: PathBuf,
        app: PathBuf,
        max_running: usize,
        mock_llm: bool,
        host_bind: String,
        host_port: u16,
    ) -> Self {
        Self {
            host_bin,
            app,
            max_running,
            mock_llm,
            host_bind,
            host_port,
            running: Mutex::new(HashMap::new()),
            resident: Mutex::new(None),
        }
    }

    /// 管理员在首页安排的那个后台小镇（见 resident.rs）；换镇时页面与这里都要跟着改。
    pub fn set_resident(&self, id: Option<String>) {
        *self.resident.lock().unwrap() = id;
    }

    fn is_resident(&self, id: &str) -> bool {
        self.resident.lock().unwrap().as_deref() == Some(id)
    }

    pub fn is_running(&self, id: &str) -> bool {
        let mut running = self.running.lock().unwrap();
        let alive = running.get_mut(id).map(|record| alive(&mut record.child));
        if alive == Some(false) {
            running.remove(id);
        }
        alive == Some(true)
    }

    /// 同时运行的小镇已经跑满（不算已经退出的，也不算后台常驻的那个）
    pub fn full(&self) -> bool {
        let resident = self.resident.lock().unwrap().clone();
        let mut running = self.running.lock().unwrap();
        running.retain(|_, record| alive(&mut record.child));
        let count = running
            .keys()
            .filter(|id| resident.as_deref() != Some(id.as_str()))
            .count();
        count >= self.max_running
    }

    /// 除了 except 之外最久没人进过的运行中小镇（后台常驻的那个不算：不能被挤掉）
    pub fn least_recent(&self, except: &str) -> Option<String> {
        let resident = self.resident.lock().unwrap().clone();
        let running = self.running.lock().unwrap();
        running
            .iter()
            .filter(|(id, _)| id.as_str() != except && resident.as_deref() != Some(id.as_str()))
            .min_by_key(|(_, record)| record.used)
            .map(|(id, _)| id.clone())
    }

    /// 打开小镇：已在运行就核对身份后直接返回，否则启动 host 并等它写就绪文件。
    /// `config` 是开镇人的那份应用配置（管理员一份、普通账号各一份），世界启动时就用它思考。
    /// 同一小镇的开关由调用方串行；跑满时由调用方先腾出位置。
    pub fn open(&self, storage: &Storage, id: &str, config: &Path) -> Result<Value, ApiError> {
        let map = storage.map(id)?;
        let existing = self.is_running(id).then(|| self.endpoint(id)).flatten();
        if let Some(endpoint) = existing {
            let lease = crate::token();
            if let Some(record) = self.running.lock().unwrap().get_mut(id) {
                record.used = Instant::now();
                record.lease = lease.clone();
            }
            let signed = self
                .signed_endpoint(id)
                .ok_or_else(|| ApiError::bad("这个小镇没在运行"))?;
            verify(&signed, id, &map.hash)?;
            return info(storage, id, &map.document, &map.hash, &endpoint, &lease);
        }
        if self.full() && !self.is_resident(id) {
            return Err(ApiError::bad(format!(
                "同时运行的小镇已达 {} 个，请关闭其他小镇",
                self.max_running
            )));
        }
        let dir = storage.town(id)?;
        let ready = dir.join("host-ready.json");
        let token = crate::token();
        let lease = crate::token();
        let _ = fs::remove_file(&ready);
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("host.log"))?;
        let mut command = Command::new(&self.host_bin);
        command
            .arg("--map-document")
            .arg(dir.join("map.json"))
            .args(["--town-id", id, "--speed", "0"])
            .args(["--port", &self.host_port.to_string()])
            .arg("--save-file")
            .arg(dir.join("world.json"))
            .arg("--ready-file")
            .arg(&ready)
            .args(["--connection-token", &token, "--stop-on-stdin-close"])
            // 只有本机用时世界听 127.0.0.1；放到服务器上要跟着听 0.0.0.0，别的机器才连得上
            .args(["--bind", &self.host_bind]);
        if self.mock_llm {
            command.args(["--mock-llm", "--mock-delay", "0.01"]);
        }
        let mut child = host::process::no_console(&mut command)
            .current_dir(&self.app)
            .env("AI_TOWN_CONFIG", config)
            .env("AI_TOWN_LOG_DIR", dir.join("logs"))
            .stdin(Stdio::piped())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()?;
        let stdin = child.stdin.take();
        let pid = child.id();
        let deadline = Instant::now() + START_TIMEOUT;
        let endpoint = loop {
            if !alive(&mut child) {
                return Err(ApiError::bad("世界启动失败，请查看该小镇的 host.log"));
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ApiError::bad("世界启动超时"));
            }
            if let Ok(result) = read_json(&ready) {
                let identity = &result["identity"];
                if result["pid"] == pid
                    && identity["town_id"] == id
                    && identity["map_hash"] == map.hash.as_str()
                {
                    if let Some(port) = result["port"].as_u64() {
                        break format!("ws://127.0.0.1:{port}/?session={token}");
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(80));
        };
        self.running.lock().unwrap().insert(
            id.to_owned(),
            Record {
                child,
                stdin,
                endpoint: endpoint.clone(),
                token,
                used: Instant::now(),
                lease: lease.clone(),
            },
        );
        let signed = self
            .signed_endpoint(id)
            .ok_or_else(|| ApiError::bad("这个小镇没在运行"))?;
        let opened = verify(&signed, id, &map.hash)
            .and_then(|_| info(storage, id, &map.document, &map.hash, &endpoint, &lease));
        if opened.is_err() {
            let _ = self.close(id);
        }
        opened
    }

    /// 这次打开的凭证还是不是最新的
    pub fn holds(&self, id: &str, lease: &str) -> bool {
        self.running
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|r| r.lease == lease)
    }

    /// 向正在跑的世界问一件事（首页控制速度/天气、常驻心跳都用它）。没在运行就报错。
    pub fn query(
        &self,
        id: &str,
        command: Option<&Value>,
        want: impl Fn(&Value) -> bool,
    ) -> Result<Value, ApiError> {
        self.query_in(id, command, want, 5)
    }

    /// 同上，`secs` 是等回执的秒数：请人入住这种要动存档的，比问一句状态慢。
    pub fn query_in(
        &self,
        id: &str,
        command: Option<&Value>,
        want: impl Fn(&Value) -> bool,
        secs: u64,
    ) -> Result<Value, ApiError> {
        let endpoint = self
            .signed_endpoint(id)
            .ok_or_else(|| ApiError::bad("这个小镇没在运行"))?;
        if let Some(record) = self.running.lock().unwrap().get_mut(id) {
            record.used = Instant::now();
        }
        ws::query_in(&endpoint, command, want, Duration::from_secs(secs))
    }

    /// 现在跑得怎么样：速度、天气、有没有设好世界观、有没有开天气。没在运行回 None。
    /// 与 scripts/towns/town-routes.mjs 的 observe 同一个形状，页面两边都认。
    pub fn observe(&self, id: &str) -> Option<Value> {
        if !self.is_running(id) {
            return None;
        }
        let roster = self.query(id, None, |m| m["type"] == "roster").ok()?;
        let settings = self
            .query(id, Some(&json!({ "type": "get_world_settings" })), |m| {
                m["type"] == "world_settings"
            })
            .ok()?;
        let environment = &roster["environment"];
        let weather = environment
            .is_object()
            .then(|| json!({ "mode": environment["mode"], "kind": environment["kind"] }));
        Some(json!({
            "speed": roster["speed"],
            "weather": weather,
            "ready": settings["state"]["ready"].as_bool().unwrap_or(false),
            "climate": settings["state"]["physiology"]["weather"].as_bool().unwrap_or(false),
        }))
    }

    /// 把速度设上去并等广播里确认（世界还在设定世界观阶段时会拒绝，交给调用方决定怎么提示）。
    pub fn apply_speed(&self, id: &str, speed: f64) -> Result<(), ApiError> {
        if !self.is_running(id) {
            return Ok(());
        }
        let command = json!({
            "type": "set_speed",
            "request_id": format!("resident-{id}"),
            "speed": speed,
        });
        self.query(id, Some(&command), |m| {
            m["type"] == "roster" && (m["speed"].as_f64().unwrap_or(-1.0) - speed).abs() < 1e-9
        })?;
        Ok(())
    }

    fn endpoint(&self, id: &str) -> Option<String> {
        self.running
            .lock()
            .unwrap()
            .get(id)
            .map(|r| r.endpoint.clone())
    }

    /// 管理服务自己用的地址：在世界口令签的服务票上，找世界问事、请人入住都靠它。
    fn signed_endpoint(&self, id: &str) -> Option<String> {
        let ticket = self.ticket(id, None, true)?;
        self.endpoint(id)
            .map(|endpoint| with_ticket(&endpoint, &ticket))
    }

    /// 签一张票：`user` 是登录账号、`admin` 是它在小镇里的角色；服务票不带账号。
    pub fn ticket(&self, id: &str, user: Option<&str>, admin: bool) -> Option<String> {
        let token = self
            .running
            .lock()
            .unwrap()
            .get(id)
            .map(|r| r.token.clone())?;
        // 按整点给到期时刻：同一小时内反复进镇拿到的是同一张票（页面上不跳动，也好比对）
        let expires = ((now_secs() / 3600) + 1) * 3600 + host::ticket::TTL;
        let ticket = match user {
            Some(user) => host::ticket::Ticket::user(user, admin, id, expires),
            None => host::ticket::Ticket::service(id, expires),
        };
        Some(host::ticket::sign(&token, &ticket))
    }

    /// 页面连世界用的地址：换成这个账号自己的票（管理服务自己那部分不带账号）。
    pub fn page_endpoint(&self, id: &str, user: Option<&str>, admin: bool, base: &str) -> String {
        match self.ticket(id, user, admin) {
            Some(ticket) => with_ticket(base, &ticket),
            None => base.to_owned(),
        }
    }

    /// 先让 host 保存后退出（见 terminate）；超时则强制结束并报错，让调用方知道保存可能不完整。
    pub fn close(&self, id: &str) -> Result<(), ApiError> {
        let Some(mut record) = self.running.lock().unwrap().remove(id) else {
            return Ok(());
        };
        if !alive(&mut record.child) {
            return Ok(());
        }
        terminate(&mut record);
        let deadline = Instant::now() + CLOSE_TIMEOUT;
        while Instant::now() < deadline {
            if !alive(&mut record.child) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = record.child.kill();
        let _ = record.child.wait();
        Err(ApiError::bad(format!(
            "世界在 {} 秒内没有完成保存，已强制结束",
            CLOSE_TIMEOUT.as_secs()
        )))
    }

    pub fn ids(&self) -> Vec<String> {
        self.running.lock().unwrap().keys().cloned().collect()
    }
}

/// 让 host 保存后退出：unix 上发 SIGTERM；Windows 没有这个信号，关掉它的标准输入，效果一样。
#[cfg(unix)]
fn terminate(record: &mut Record) {
    unsafe {
        libc::kill(record.child.id() as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn terminate(record: &mut Record) {
    record.stdin.take();
}

/// 在端点 URL 上换一张票：旧票去掉，新票接上（同一个页面可能被重新发过地址）。
fn with_ticket(endpoint: &str, ticket: &str) -> String {
    let (head, query) = endpoint.split_once('?').unwrap_or((endpoint, ""));
    let mut parts: Vec<String> = query
        .split('&')
        .filter(|part| !part.is_empty() && !part.starts_with("ticket="))
        .map(str::to_owned)
        .collect();
    parts.push(format!("ticket={ticket}"));
    format!("{head}?{}", parts.join("&"))
}

/// 现在（unix 秒）：签票时要写上到期时刻。
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn verify(endpoint: &str, id: &str, hash: &str) -> Result<(), ApiError> {
    let identity = ws::query(endpoint, None, |m| m["type"] == "world_identity")?;
    if identity["town_id"] != id || identity["map_hash"] != hash {
        return Err(ApiError::bad("世界与地图身份不一致"));
    }
    Ok(())
}

fn info(
    storage: &Storage,
    id: &str,
    document: &Value,
    hash: &str,
    endpoint: &str,
    lease: &str,
) -> Result<Value, ApiError> {
    let settings = ws::query(
        endpoint,
        Some(&json!({ "type": "get_world_settings" })),
        |m| m["type"] == "world_settings",
    )?;
    let (name, description, creation) = storage.labels(id, document);
    Ok(json!({
        "id": id,
        "name": name,
        "description": description,
        "creation": creation,
        "version": "1",
        "clientKind": "town-2d",
        "views": ["2d"],
        "available": true,
        "mapHash": hash,
        "worldId": settings["state"]["world_id"],
        "endpoint": endpoint,
        "lease": lease,
    }))
}
