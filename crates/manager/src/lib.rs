//! 本机小镇管理服务（Rust 版）：页面、小镇列表、按需启动世界进程。
//! 手机版由应用壳启动；桌面版目前仍是 scripts/town-manager.mjs，两边的接口一致，
//! 建镇（地图生成）暂时只在桌面版。
mod accounts;
mod agents;
mod builtin;
mod creation;
pub mod error;
mod hosts;
pub mod http;
mod ledger;
mod positions;
mod prices;
mod resident;
mod routes;
pub mod storage;
mod usage;
mod ws;

use error::ApiError;
use hosts::Hosts;
use rand::RngCore;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use storage::Storage;

pub struct Options {
    /// 用户数据目录：towns/、config/。
    pub root: PathBuf,
    /// 应用自带的数据目录（含 data/ 与 config/）。
    pub app: PathBuf,
    /// 前端构建目录（index.html、game.html、assets/）。
    pub web: PathBuf,
    pub host_bin: PathBuf,
    /// 0 表示随机端口；非 0 时被占用就往后找 10 个。
    pub port: u16,
    /// 监听地址：缺省只给本机；放到服务器上时传 0.0.0.0（或那台机器的内网地址）。
    pub bind: String,
    /// 允许从别的名字访问（域名）：用 IP 访问不用设，页面与接口的地址按请求自己的 Host 拼。
    pub allow_host: Option<String>,
    /// 世界自己的端口：0 表示每次随机；放到服务器上时固定一个，防火墙只开这一个。
    pub host_port: u16,
    pub ready_file: Option<PathBuf>,
    /// 设了口令时，接口只认带会话 Cookie 的请求（同机其他应用也能连 127.0.0.1）。
    pub session_secret: Option<String>,
    pub max_running: usize,
    pub mock_llm: bool,
    pub stop_on_stdin_close: bool,
    /// 放到公网服务器上时只开放后台常驻的那一个小镇：连管理员也不能进别的镇。
    pub only_resident: bool,
}

const USAGE: &str = "town-manager --root <数据目录> --app <应用数据目录> --web <前端构建目录> \
--host-bin <host> [--port 0] [--bind 127.0.0.1] [--allow-host 域名] [--host-port 0] \
[--ready-file 路径] [--session-secret 口令] [--max-running 1] [--mock-llm] [--stop-on-stdin-close] \
[--only-resident]";

impl Options {
    pub fn parse(args: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut values: HashMap<String, String> = HashMap::new();
        let mut flags = Vec::new();
        let mut it = args;
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--mock-llm" | "--stop-on-stdin-close" | "--only-resident" => flags.push(arg),
                "--root" | "--app" | "--web" | "--host-bin" | "--port" | "--ready-file"
                | "--session-secret" | "--max-running" | "--bind" | "--allow-host"
                | "--host-port" => {
                    let value = it.next().ok_or_else(|| format!("{arg} 缺少参数值"))?;
                    values.insert(arg, value);
                }
                other => return Err(format!("未知参数 {other}\n{USAGE}")),
            }
        }
        // 世界进程的工作目录与本进程不同，相对路径一律先转成绝对路径。
        let path = |key: &str| {
            let value = values
                .get(key)
                .map(PathBuf::from)
                .ok_or_else(|| format!("缺少 {key}\n{USAGE}"))?;
            Ok::<_, String>(std::path::absolute(&value).unwrap_or(value))
        };
        let number = |key: &str, default: usize| -> Result<usize, String> {
            values.get(key).map_or(Ok(default), |v| {
                v.parse().map_err(|_| format!("{key} 的值无效：{v}"))
            })
        };
        Ok(Self {
            root: path("--root")?,
            app: path("--app")?,
            web: path("--web")?,
            host_bin: path("--host-bin")?,
            port: number("--port", 0)? as u16,
            // 缺省只听本机：放到服务器上时用 --bind 0.0.0.0（世界进程会跟着听 0.0.0.0）
            bind: values
                .get("--bind")
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "127.0.0.1".into()),
            allow_host: values
                .get("--allow-host")
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
            // 世界自己的端口：0 是每次随机；服务器上固定一个，防火墙只开这一个
            host_port: number("--host-port", 0)? as u16,
            ready_file: values
                .get("--ready-file")
                .map(|p| std::path::absolute(p).unwrap_or_else(|_| PathBuf::from(p))),
            session_secret: values.get("--session-secret").cloned(),
            // 同时只运行一个小镇：退出就保存关闭，进另一个小镇时先关掉还开着的那个
            max_running: number("--max-running", 1)?.max(1),
            mock_llm: flags.iter().any(|f| f == "--mock-llm"),
            stop_on_stdin_close: flags.iter().any(|f| f == "--stop-on-stdin-close"),
            // 只开放常驻小镇：命令行开关，或者服务器上用环境变量打开（桌面端不必动参数）
            only_resident: flags.iter().any(|f| f == "--only-resident")
                || std::env::var("TOWN_ONLY_RESIDENT").is_ok_and(|v| v == "1"),
        })
    }
}

pub struct App {
    pub options: Options,
    storage: Storage,
    hosts: Hosts,
    town_locks: TownLocks,
    /// 用户目录里的应用配置（模型服务、密钥、道具库路径），建镇时读；也是管理员账号的那一份
    config: std::path::PathBuf,
    /// 这台电脑上的账号：管理员、朋友各自的档案与密钥（见 accounts.rs）
    accounts: std::sync::Mutex<accounts::Accounts>,
    drafts: creation::Drafts,
    /// 内置模型的下载线程
    downloads: builtin::Downloads,
    /// 被挤掉的小镇 → 挤掉它的小镇：另一个页面进了别的小镇时，这个页面断线后不自动抢回来
    displaced: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
    /// 正在被页面打开的小镇：关掉旧的、启动新的这段时间里它还不在运行，也算占着
    claiming: std::sync::Mutex<std::collections::BTreeSet<String>>,
    /// 后台常驻的小镇与它的速度（见 resident.rs）
    resident: resident::Resident,
}

impl App {
    fn stopping(&self) -> bool {
        host::process::stopping()
    }

    /// 要进的小镇没在运行、而同时运行的小镇已经跑满：先保存并关掉最久没人进过的，腾出位置。
    /// 手机上只跑一个小镇，进另一个就等于换过去，不用玩家自己去关。
    fn make_room(&self, id: &str) -> Result<(), ApiError> {
        while !self.hosts.is_running(id) && self.hosts.full() {
            let Some(oldest) = self.hosts.least_recent(id) else {
                break;
            };
            self.displaced
                .lock()
                .unwrap()
                .insert(oldest.clone(), id.to_owned());
            let _serial = self.town_lock(&oldest);
            self.hosts.close(&oldest)?;
        }
        self.displaced.lock().unwrap().remove(id);
        Ok(())
    }

    /// 管理员挑的后台小镇没在跑就把它拉起来（进程退出、崩溃、有人手动关掉之后都靠这里）。
    /// 与 scripts/town-manager.mjs 的 ensureResident 同一个行为：不设世界观时先拉起来但不改速度。
    fn ensure_resident(&self) {
        let Some(id) = self.resident.town() else {
            return;
        };
        if self.hosts.is_running(&id) {
            return;
        }
        let config = {
            let accounts = self.accounts.lock().unwrap();
            let Some(admin) = accounts.admin() else {
                return;
            };
            match accounts.config(&self.config, &admin) {
                Ok(config) => config,
                Err(e) => {
                    eprintln!("[town-manager] 常驻小镇的配置读不到：{}", e.message);
                    return;
                }
            }
        };
        let _serial = self.town_lock(&id);
        if self.hosts.is_running(&id) {
            return;
        }
        match self.hosts.open(&self.storage, &id, &config) {
            Ok(_) => {
                // 世界是新的，内存里没有密钥：把这个镇里已投放的 agent 再送一遍
                routes::resend_keys(self, &id);
                let ready = self
                    .hosts
                    .observe(&id)
                    .is_some_and(|state| state["ready"].as_bool().unwrap_or(false));
                if ready {
                    if let Err(e) = self.hosts.apply_speed(&id, self.resident.speed()) {
                        eprintln!("[town-manager] 常驻小镇的速度没设上：{}", e.message);
                    }
                }
                println!("[town-manager] 常驻小镇已启动：{id}");
            }
            Err(e) => eprintln!("[town-manager] 常驻小镇没启动起来：{id}：{}", e.message),
        }
    }

    /// 心跳里顺手折一次各账号的跨天账本：人不在首页（没有 `GET /usage`）也不会把昨天丢掉。
    fn fold_ledgers(&self) {
        if self.hosts.ids().is_empty() {
            return;
        }
        let homes: Vec<PathBuf> = {
            let accounts = self.accounts.lock().unwrap();
            accounts
                .list()
                .iter()
                .map(|user| accounts.home(&user.id))
                .collect()
        };
        for home in homes {
            if let Err(error) = usage::fold_towns(&self.hosts, &home) {
                eprintln!("[town-manager] 折账本没成功：{}", error.message);
            }
        }
    }

    /// 就不抢回来，告诉页面原因；不然两个页面会来回互相挤。电脑版管理服务按同样的规则。
    fn refuse_displaced(&self, id: &str, automatic: bool) -> Result<(), ApiError> {
        let by = self.displaced.lock().unwrap().get(id).cloned();
        let taken =
            |by: &str| self.hosts.is_running(by) || self.claiming.lock().unwrap().contains(by);
        match by {
            Some(by) if automatic && taken(&by) => {
                let name = self.storage.name(&by);
                Err(ApiError::new(
                    409,
                    format!("另一个页面打开了「{name}」，同一时间只能运行一个小镇"),
                ))
            }
            _ => Ok(()),
        }
    }

    /// 页面正在打开这个小镇，直到这次打开结束（成功或失败都放开）。
    fn claim(&self, id: &str) -> Claim<'_> {
        self.claiming.lock().unwrap().insert(id.to_owned());
        Claim {
            claiming: &self.claiming,
            id: id.to_owned(),
        }
    }

    /// 同一个小镇的开关、删除与道具摆放串行执行。
    fn town_lock(&self, id: &str) -> TownGuard<'_> {
        let mut busy = self.town_locks.busy.lock().unwrap();
        while busy.contains(id) {
            busy = self.town_locks.freed.wait(busy).unwrap();
        }
        busy.insert(id.to_owned());
        TownGuard {
            locks: &self.town_locks,
            id: id.to_owned(),
        }
    }
}

#[derive(Default)]
struct TownLocks {
    busy: Mutex<HashSet<String>>,
    freed: Condvar,
}

/// 正在打开的标记，打开结束时（离开作用域）放开。
struct Claim<'a> {
    claiming: &'a std::sync::Mutex<std::collections::BTreeSet<String>>,
    id: String,
}
impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.claiming.lock().unwrap().remove(&self.id);
    }
}

struct TownGuard<'a> {
    locks: &'a TownLocks,
    id: String,
}

impl Drop for TownGuard<'_> {
    fn drop(&mut self) {
        self.locks.busy.lock().unwrap().remove(&self.id);
        self.locks.freed.notify_all();
    }
}

/// 32 位十六进制随机串：连接口令、临时目录名。
pub fn token() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 一个数据目录只允许一个管理服务；上一个进程已退出时接管它留下的锁。
fn acquire_lock(root: &std::path::Path) -> Result<PathBuf, ApiError> {
    let lock = root.join("manager.lock");
    std::fs::create_dir_all(root)?;
    if std::fs::create_dir(&lock).is_err() {
        let owner = storage::read_json(&lock.join("owner.json")).ok();
        let pid = owner.and_then(|o| o["pid"].as_u64());
        let running = pid
            .and_then(|pid| u32::try_from(pid).ok())
            .is_some_and(host::process::still_running);
        if running {
            return Err(ApiError::bad("此数据目录已有小镇管理服务，请先关闭该服务"));
        }
        let _ = std::fs::remove_dir_all(&lock);
        std::fs::create_dir(&lock)?;
    }
    storage::write_json(
        &lock.join("owner.json"),
        &json!({ "pid": std::process::id() }),
    )?;
    Ok(lock)
}

/// 只给本机：不对外监听，页面与接口只认回环地址
pub(crate) fn is_loopback(addr: &str) -> bool {
    matches!(addr, "127.0.0.1" | "localhost" | "::1")
}

fn bind(port: u16, addr: &str) -> Result<TcpListener, String> {
    let tries = if port == 0 { 1 } else { 10 };
    let mut last = String::new();
    for offset in 0..tries {
        match TcpListener::bind((addr, port.saturating_add(offset))) {
            Ok(listener) => return Ok(listener),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("无法监听 {addr}:{port}：{last}"))
}

pub fn run(options: Options) -> Result<(), String> {
    let storage = Storage::new(options.root.clone(), options.app.clone());
    storage.init().map_err(|e| e.message)?;
    let lock = acquire_lock(&options.root).map_err(|e| e.message)?;
    let served = serve(options, storage);
    let _ = std::fs::remove_dir_all(&lock);
    served
}

fn serve(options: Options, storage: Storage) -> Result<(), String> {
    let config = storage::setup_config(&options.root, &options.app).map_err(|e| e.message)?;
    let accounts = accounts::Accounts::load(&options.root).map_err(|e| e.message)?;
    // 世界进程跟着管理服务一起对外：本机用时只听回环，放到服务器上时听所有网卡
    let host_bind = if is_loopback(&options.bind) {
        "127.0.0.1".to_string()
    } else {
        "0.0.0.0".to_string()
    };
    let hosts = Hosts::new(
        options.host_bin.clone(),
        options.app.clone(),
        options.max_running,
        options.mock_llm,
        host_bind,
        options.host_port,
    );
    let listener = bind(options.port, &options.bind)?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    if let Some(ready) = &options.ready_file {
        let ready_json = json!({ "pid": std::process::id(), "port": port });
        host::persistence::atomic_write(ready, ready_json.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
    }
    println!(
        "[town-manager] http://{}:{port} · {}",
        options.bind,
        options.root.display()
    );
    if !is_loopback(&options.bind) {
        println!("[town-manager] 已对外开放：别的机器用这台机器的 IP:{port} 访问（HTTP 明文，公网请套 TLS 反向代理）");
    }
    let root = options.root.clone();
    let app = Arc::new(App {
        options,
        storage,
        hosts,
        town_locks: TownLocks::default(),
        config,
        accounts: std::sync::Mutex::new(accounts),
        drafts: creation::Drafts::default(),
        downloads: builtin::Downloads::default(),
        displaced: Default::default(),
        claiming: Default::default(),
        resident: resident::Resident::load(&root),
    });
    // 后台常驻的小镇：进来了就拉起来，之后每 15 秒看一次在不在（进程没了就再拉）。
    app.hosts.set_resident(app.resident.town());
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            if host::process::stopping() {
                return;
            }
            app.ensure_resident();
            app.fold_ledgers();
            std::thread::sleep(Duration::from_secs(15));
        });
    }
    while !host::process::stopping() {
        match listener.accept() {
            Ok((stream, _)) => {
                let app = app.clone();
                std::thread::spawn(move || connection(&app, stream));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(30));
            }
            Err(e) => eprintln!("[town-manager] {e}"),
        }
    }
    // 让各世界保存退出。
    let mut failed = Vec::new();
    for id in app.hosts.ids() {
        if let Err(e) = app.hosts.close(&id) {
            failed.push(e.message);
        }
    }
    println!("[town-manager] 已退出");
    if failed.is_empty() {
        Ok(())
    } else {
        Err(failed.join("；"))
    }
}

fn connection(app: &App, mut stream: TcpStream) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let request = match http::read_request(&mut stream) {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(e) => {
            let error = ApiError::new(413, e.to_string());
            let _ = http::write_response(
                &mut stream,
                &http::Response::json(413, &error.body()),
                false,
            );
            return;
        }
    };
    let response = routes::handle(app, &request);
    let _ = http::write_response(&mut stream, &response, request.method == "HEAD");
}
