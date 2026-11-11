//! 接口与页面路由。路径与 scripts/towns/*-routes.mjs 一致；建镇（地图生成）暂时只有桌面版。
use crate::accounts::{self, Role, User, USER_COOKIE};
use crate::error::ApiError;
use crate::http::{Request, Response};
use crate::positions::positions;
use crate::storage::safe_id;
use crate::App;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// 会话口令放在这个 Cookie 里；应用壳先用口令打开 /__session 拿到它。
pub const SESSION_COOKIE: &str = "town_session";

/// 天气可以选的那几种（与 protocol 的 WeatherKind 一致）
const WEATHERS: [&str; 7] = [
    "clear",
    "overcast",
    "light_rain",
    "rain",
    "heavy_rain",
    "thunderstorm",
    "snow",
];

pub fn handle(app: &App, req: &Request) -> Response {
    match dispatch(app, req) {
        Ok(response) => response,
        Err(e) => {
            if e.status >= 500 {
                eprintln!("[town-manager] {} {}: {}", req.method, req.path, e.message);
            }
            Response::json(e.status, &e.body())
        }
    }
}

fn dispatch(app: &App, req: &Request) -> Result<Response, ApiError> {
    let host = req.header("host").unwrap_or_default();
    let local = ["127.0.0.1", "localhost"]
        .iter()
        .any(|h| host == *h || host.strip_prefix(h).is_some_and(|p| p.starts_with(':')));
    if !local {
        return Err(ApiError::new(403, "仅提供本机服务"));
    }
    if app.stopping() {
        return Err(ApiError::new(503, "应用正在退出"));
    }
    let path = req.path.as_str();
    let get = matches!(req.method.as_str(), "GET" | "HEAD");
    if path == "/__session" && get {
        return session(app, req);
    }
    if let Some(rest) = path.strip_prefix("/api/towns") {
        if let Some(secret) = &app.options.session_secret {
            if req.cookie(SESSION_COOKIE) != Some(secret.as_str()) {
                return Err(ApiError::new(403, "无效的应用请求"));
            }
        }
        return api(app, req, rest, get);
    }
    if !get {
        return Err(ApiError::new(404, "操作不存在"));
    }
    if path == "/data/props/core/definitions.json" {
        let bytes = fs::read(app.storage.app.join("data/props/core/definitions.json"))?;
        return Ok(file_response(bytes, "application/json", "no-cache"));
    }
    static_file(app, req, path)
}

/// 应用壳带着口令打开这里，换到会话 Cookie 后回到首页；口令不再出现在页面地址里。
fn session(app: &App, req: &Request) -> Result<Response, ApiError> {
    let Some(secret) = &app.options.session_secret else {
        return Ok(Response::redirect("/", None));
    };
    if req.query.get("k") != Some(secret) {
        return Err(ApiError::new(403, "无效的应用请求"));
    }
    let next = req
        .query
        .get("next")
        .filter(|n| n.starts_with('/') && !n.starts_with("//"))
        .cloned()
        .unwrap_or_else(|| "/".into());
    let cookie = format!("{SESSION_COOKIE}={secret}; Path=/; HttpOnly; SameSite=Strict");
    Ok(Response::redirect(&next, Some(cookie)))
}

fn body(req: &Request) -> Result<Value, ApiError> {
    if req.header("x-town-client") != Some("1")
        || !req
            .header("content-type")
            .is_some_and(|t| t.starts_with("application/json"))
    {
        return Err(ApiError::new(403, "无效的应用请求"));
    }
    serde_json::from_slice(&req.body).map_err(|_| ApiError::bad("请求内容不是有效的 JSON"))
}

/// 这次请求是谁：带着 `town_user` Cookie 就是这个账号；还没建管理员时算那个没设密码的管理员；
/// 其余情况谁也不算（页面要先建号/选号）。
fn current(app: &App, req: &Request) -> Option<User> {
    app.accounts
        .lock()
        .unwrap()
        .current(req.cookie(USER_COOKIE))
}

/// 要账号的接口：没建号/没选号时先让页面去设定里建一个。
fn account_needed() -> ApiError {
    let mut error = ApiError::new(401, "先在首页「设定」里创建或选择一个账号");
    error.code = Some("account".into());
    error
}

/// 这个账号的应用配置：管理员用小镇的公共配置，普通账号各用自己目录下那份（自己填的密钥）。
fn user_config(app: &App, user: &User) -> Result<std::path::PathBuf, ApiError> {
    app.accounts.lock().unwrap().config(&app.config, user)
}

fn account_cookie(id: &str) -> String {
    format!("{USER_COOKIE}={id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000")
}

/// 账号接口：第一次建管理员、管理员给朋友建号、切换档案、改密码。
fn accounts_api(app: &App, req: &Request, rest: &str, get: bool) -> Result<Response, ApiError> {
    let me = current(app, req);
    match (get, rest) {
        (true, "/users") => {
            let accounts = app.accounts.lock().unwrap();
            Ok(Response::json(
                200,
                &json!({
                    "current": me.as_ref().map(|user| user.public()),
                    "users": accounts.list().iter().map(User::public).collect::<Vec<_>>(),
                    "max": accounts::MAX_USERS,
                    "admin": me.as_ref().is_some_and(|user| user.role == Role::Admin),
                    "needs_setup": accounts.needs_setup(),
                }),
            ))
        }
        (false, "/users/setup") => {
            let request = body(req)?;
            let user = app.accounts.lock().unwrap().setup(
                request["name"].as_str().unwrap_or_default(),
                request["pin"].as_str().unwrap_or_default(),
            )?;
            // 建完就是这个人：直接换到他的档案
            Ok(Response::json_cookie(
                200,
                &json!({ "ok": true, "current": user.public() }),
                account_cookie(&user.id),
            ))
        }
        (false, "/users") => {
            let me = me.ok_or_else(account_needed)?;
            if me.role != Role::Admin {
                return Err(ApiError::new(403, "只有管理员可以创建账号"));
            }
            let request = body(req)?;
            let user = app.accounts.lock().unwrap().create(
                request["name"].as_str().unwrap_or_default(),
                request["pin"].as_str().unwrap_or_default(),
            )?;
            // 建完仍留在管理员这边：朋友在这台电脑上自己选进他的档案。
            Ok(Response::json(
                200,
                &json!({ "ok": true, "user": user.public() }),
            ))
        }
        (false, "/users/select") => {
            let request = body(req)?;
            let id = request["id"].as_str().unwrap_or_default();
            let pin = request["pin"].as_str();
            let user = app.accounts.lock().unwrap().select(id, pin)?;
            Ok(Response::json_cookie(
                200,
                &json!({ "ok": true, "current": user.public() }),
                account_cookie(&user.id),
            ))
        }
        (false, "/users/pin") => {
            let me = me.ok_or_else(account_needed)?;
            let request = body(req)?;
            let user = app.accounts.lock().unwrap().set_pin(
                &me.id,
                request["current"].as_str(),
                request["pin"].as_str(),
            )?;
            Ok(Response::json(
                200,
                &json!({ "ok": true, "current": user.public() }),
            ))
        }
        (false, "/users/avatar") => {
            let me = me.ok_or_else(account_needed)?;
            // 页面记下自己认下的那个化身（「一个账号一个固定化身」）：传 null 就解开
            let request = body(req)?;
            let avatar = match request["id"].as_str() {
                Some(id) => Some((
                    id.to_owned(),
                    request["name"].as_str().unwrap_or_default().to_owned(),
                )),
                None => None,
            };
            let user = app.accounts.lock().unwrap().set_avatar(&me.id, avatar)?;
            Ok(Response::json(
                200,
                &json!({ "ok": true, "current": user.public() }),
            ))
        }
        _ => Err(ApiError::new(404, "操作不存在")),
    }
}

fn api(app: &App, req: &Request, rest: &str, get: bool) -> Result<Response, ApiError> {
    let ok = |value: Value| Ok(Response::json(200, &value));
    if rest == "/users" || rest.starts_with("/users/") {
        return accounts_api(app, req, rest, get);
    }
    let me = current(app, req);
    // 健康检查先答：第一次打开、还没建号时页面也靠它确认服务在
    if get && rest == "/health" {
        return ok(json!({
            "kind": "town-manager",
            "version": 1,
            "pid": std::process::id(),
            "source": app.storage.app.to_string_lossy(),
            "user": me.map(|user| user.public()),
        }));
    }
    // 别的接口都要按账号走（各自的密钥、各自的化身），没账号就问页面要
    let me = me.ok_or_else(account_needed)?;
    match (get, rest) {
        (true, "") => {
            let resident = app.resident.town();
            let towns: Vec<Value> = app
                .storage
                .list()?
                .into_iter()
                .map(|mut town| {
                    let id = town["id"].as_str().unwrap_or_default().to_owned();
                    town["running"] = Value::from(app.hosts.is_running(&id));
                    town["resident"] = Value::from(resident.as_deref() == Some(id.as_str()));
                    town
                })
                .collect();
            let status = resident.as_deref().and_then(|id| app.hosts.observe(id));
            return ok(json!({
                "towns": towns,
                "resident": resident,
                "status": status,
                "admin": me.role == Role::Admin,
            }));
        }
        // 建镇：生成在网页里做，这里理解描述、校验成品、暂存草稿、保存（见 creation.rs）
        (true, "/options") => return ok(crate::creation::options(&user_config(app, &me)?)),
        (false, "/parse") => {
            return ok(crate::creation::parse(
                &user_config(app, &me)?,
                &body(req)?,
            )?)
        }
        (false, "/drafts") => return ok(app.drafts.put(&user_config(app, &me)?, &body(req)?)?),
        (false, "/save") => return ok(app.drafts.save(&app.storage, &body(req)?)?),
        (false, "/preview") => {
            return Err(ApiError::bad("请更新应用：建镇预览在页面里生成"));
        }
        // 首页「设定」的模型服务：读、存、连通测试。逻辑在 host::models，电脑版经 town-map 调同一份
        (true, "/models") => {
            return ok(host::models::read(&crate::creation::load_app(
                &user_config(app, &me)?,
            )?)?)
        }
        (false, "/models") => {
            let app = crate::creation::load_app(&user_config(app, &me)?)?;
            return ok(host::models::write(&app, &body(req)?)?);
        }
        (false, "/models/test") => {
            let app = crate::creation::load_app(&user_config(app, &me)?)?;
            return ok(host::models::check(&app, &body(req)?)?);
        }
        // 内置模型的状态、看有没有新版本、下载暂停删除（host::builtin_store），电脑版经 town-map 调同一份
        (true, "/builtin-model") => {
            let config = crate::creation::load_app(&user_config(app, &me)?)?;
            return ok(host::builtin_store::status(&config)?);
        }
        (false, "/builtin-model") => {
            let config = crate::creation::load_app(&user_config(app, &me)?)?;
            let request = body(req)?;
            if request["action"] == "check" {
                return ok(host::builtin_store::check(&config)?);
            }
            let status = host::builtin_store::act(&config, &request)?;
            if request["action"] == "download" {
                app.downloads.ensure(&user_config(app, &me)?);
            }
            return ok(status);
        }
        _ => {}
    }
    let mut parts = rest.trim_start_matches('/').splitn(2, '/');
    let (id, action) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    let id = safe_id(id)?;
    match (get, action) {
        (true, "map") => {
            let map = app.storage.map(id)?;
            if req.query.get("hash").is_some_and(|h| *h != map.hash) {
                return Err(ApiError::bad("地图已变化，请返回小镇列表重新打开"));
            }
            Ok(Response::raw_json(map.bytes))
        }
        (false, "open") => {
            let automatic = body(req)?["automatic"].as_bool().unwrap_or(false);
            app.refuse_displaced(id, automatic)?;
            // 有后台运行的小镇时，别人只能进那一个：管理员想换，先在首页把常驻换过来
            let resident = app.resident.town();
            if resident.as_deref().is_some_and(|resident| resident != id) && me.role != Role::Admin
            {
                let resident = resident.unwrap_or_default();
                let mut error = ApiError::new(
                    403,
                    format!(
                        "现在后台运行的是「{}」，同一时间只有一个小镇在跑",
                        app.storage.name(&resident)
                    ),
                );
                error.code = Some("resident".into());
                return Err(error);
            }
            let _claim = app.claim(id);
            app.make_room(id)?;
            let _serial = app.town_lock(id);
            ok(app.hosts.open(&app.storage, id, &user_config(app, &me)?)?)
        }
        (false, "close") => {
            // 常驻小镇不因为有人离开就停：它在后台跑，要它停得管理员先在首页取消常驻
            if app.resident.town().as_deref() == Some(id) {
                return ok(json!({ "ok": true, "closed": false, "resident": true }));
            }
            let lease = body(req)?["lease"].as_str().map(str::to_owned);
            let _serial = app.town_lock(id);
            // 带着打开凭证来关：之后又有页面打开过这个小镇（比如刷新），旧页面晚到的关闭不算数
            let superseded =
                lease.is_some_and(|lease| app.hosts.is_running(id) && !app.hosts.holds(id, &lease));
            if !superseded {
                app.hosts.close(id)?;
            }
            ok(json!({ "ok": true, "closed": !superseded }))
        }
        (false, "resident") => {
            if me.role != Role::Admin {
                return Err(ApiError::new(403, "只有管理员能管理后台运行的小镇"));
            }
            // 取消常驻只是不再后台看着它：正开着的世界不动，谁想进还能进
            if body(req)?["on"].as_bool() == Some(false) {
                if app.resident.town().as_deref() != Some(id) {
                    return ok(json!({ "ok": true, "resident": app.resident.town() }));
                }
                app.resident.set(None)?;
                app.hosts.set_resident(None);
                return ok(json!({ "ok": true, "resident": Value::Null }));
            }
            app.storage.map(id)?;
            app.resident.set(Some(id.to_owned()))?;
            app.hosts.set_resident(Some(id.to_owned()));
            let _claim = app.claim(id);
            app.make_room(id)?;
            let _serial = app.town_lock(id);
            let mut info = app.hosts.open(&app.storage, id, &user_config(app, &me)?)?;
            // 世界观设好的小镇才谈得上「在后台跑」：没设好的先停着，等管理员进镇设一次
            let ready = app
                .hosts
                .observe(id)
                .is_some_and(|state| state["ready"].as_bool().unwrap_or(false));
            if ready {
                if let Err(e) = app.hosts.apply_speed(id, app.resident.speed()) {
                    // 速度没设上不影响常驻：留在后台，一会儿心跳再试
                    eprintln!("[town-manager] 常驻小镇的速度没设上：{}", e.message);
                }
            }
            info["resident"] = Value::from(id);
            info["ready"] = Value::from(ready);
            ok(info)
        }
        (false, "control") => {
            if me.role != Role::Admin {
                return Err(ApiError::new(403, "只有管理员能管理后台运行的小镇"));
            }
            if app.resident.town().as_deref() != Some(id) {
                return Err(ApiError::new(403, "只能控制后台运行的那个小镇"));
            }
            let state = app
                .hosts
                .observe(id)
                .ok_or_else(|| ApiError::new(409, "这个小镇正在拉起来，稍等一会儿再试"))?;
            let request = body(req)?;
            match request["kind"].as_str() {
                Some("speed") => {
                    let speed = request["speed"].as_f64().unwrap_or(f64::NAN);
                    if !(0.0..=64.0).contains(&speed) {
                        return Err(ApiError::bad("速度不对"));
                    }
                    if !state["ready"].as_bool().unwrap_or(false) {
                        return Err(ApiError::new(
                            409,
                            "这个小镇还没设定世界观，先进镇里设定一次",
                        ));
                    }
                    app.resident.set_speed(speed)?;
                    app.hosts.apply_speed(id, speed)?;
                    ok(json!({ "ok": true, "speed": speed }))
                }
                Some("weather") => {
                    if state["weather"].is_null() {
                        return Err(ApiError::new(409, "这个小镇没开天气，先进镇里的设定打开"));
                    }
                    let roster = app.hosts.query(id, None, |m| m["type"] == "roster")?;
                    let environment = &roster["environment"];
                    if !environment.is_object() {
                        return Err(ApiError::new(409, "这个世界还没有天气"));
                    }
                    let fixed = request["mode"].as_str() == Some("fixed");
                    let kernel = request["weather"].as_str().unwrap_or_default();
                    if fixed && !WEATHERS.contains(&kernel) {
                        return Err(ApiError::bad("没有这种天气"));
                    }
                    let id_request = format!("resident-weather-{}", crate::token());
                    let mut command = json!({
                        "type": "set_weather",
                        "request_id": id_request,
                        "world_id": environment["world_id"],
                        "expected_revision": environment["revision"],
                        "mode": if fixed { "fixed" } else { "natural" },
                    });
                    if fixed {
                        command["kind"] = Value::from(kernel);
                    }
                    let saved = app.hosts.query(id, Some(&command), |m| {
                        m["type"] == "weather_saved" && m["request_id"] == command["request_id"]
                    })?;
                    if saved["ok"].as_bool() != Some(true) {
                        let message = saved["message"].as_str().unwrap_or("天气没能改");
                        return Err(ApiError::new(409, message));
                    }
                    let weather = if saved["environment"].is_object() {
                        json!({ "mode": saved["environment"]["mode"], "kind": saved["environment"]["kind"] })
                    } else {
                        json!({ "mode": if fixed { "fixed" } else { "natural" } })
                    };
                    ok(json!({ "ok": true, "weather": weather }))
                }
                _ => Err(ApiError::bad("不认识的控制")),
            }
        }
        (false, "delete") => {
            body(req)?;
            let _serial = app.town_lock(id);
            if !app.storage.can_delete(id) {
                return Err(ApiError::new(403, "内置地图不能删除"));
            }
            if app.resident.town().as_deref() == Some(id) {
                app.resident.set(None)?;
                app.hosts.set_resident(None);
            }
            app.hosts.close(id)?;
            app.storage.remove(id, false)?;
            ok(json!({ "ok": true }))
        }
        (false, "reset") => {
            body(req)?;
            let _serial = app.town_lock(id);
            if !id.starts_with("prefab-") {
                return Err(ApiError::new(403, "只有预制小镇能重新开始"));
            }
            app.hosts.close(id)?;
            app.storage.remove(id, true)?;
            ok(json!({ "ok": true }))
        }
        (false, "positions") => {
            let request = body(req)?;
            let _serial = app.town_lock(id);
            let map = app.storage.map(id)?;
            if request["map_hash"] != map.hash.as_str() {
                return Err(ApiError::bad("地图版本不匹配"));
            }
            let marks = positions(&app.storage.town(id)?, &map.document, &request["instances"])?;
            ok(json!({ "positions": marks }))
        }
        _ => Err(ApiError::new(404, "操作不存在")),
    }
}

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn file_response(body: Vec<u8>, content_type: &str, cache: &str) -> Response {
    Response {
        status: 200,
        headers: vec![
            ("Content-Type".into(), content_type.into()),
            ("Cache-Control".into(), cache.into()),
            ("Accept-Ranges".into(), "bytes".into()),
        ],
        body,
    }
}

/// 前端构建产物：首页、游戏页与 assets/ 下的文件。音频按 Range 分段返回。
fn static_file(app: &App, req: &Request, path: &str) -> Result<Response, ApiError> {
    let name = match path {
        "" | "/index.html" => "index.html",
        "/game.html" => "game.html",
        other => other
            .strip_prefix("/assets/")
            .filter(|f| {
                !f.is_empty()
                    && f.chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                    && !f.starts_with('.')
            })
            .map(|_| other.trim_start_matches('/'))
            .ok_or_else(|| ApiError::new(404, "操作不存在"))?,
    };
    let full = app.options.web.join(name);
    let bytes = fs::read(&full).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ApiError::new(404, "页面不存在，请先构建前端"),
        _ => ApiError::from(e),
    })?;
    let cache = if name.ends_with(".html") {
        "no-store"
    } else {
        IMMUTABLE
    };
    let kind = content_type(&full);
    if let Some(range) = req.header("range").and_then(|r| r.strip_prefix("bytes=")) {
        return Ok(partial(bytes, kind, cache, range));
    }
    Ok(file_response(bytes, kind, cache))
}

/// 单段 Range：`a-b`、`a-` 或 `-n`。
fn partial(bytes: Vec<u8>, kind: &str, cache: &str, range: &str) -> Response {
    let len = bytes.len();
    let (start, end) = match range.split_once('-') {
        Some(("", n)) => match n.parse::<usize>() {
            Ok(n) if n > 0 => (len.saturating_sub(n), len.saturating_sub(1)),
            _ => (len, 0),
        },
        Some((a, b)) => {
            let start = a.parse::<usize>().unwrap_or(len);
            let end = b.parse::<usize>().unwrap_or(len.saturating_sub(1));
            (start, end.min(len.saturating_sub(1)))
        }
        None => (len, 0),
    };
    if start >= len || start > end {
        return Response {
            status: 416,
            headers: vec![("Content-Range".into(), format!("bytes */{len}"))],
            body: Vec::new(),
        };
    }
    let mut response = file_response(bytes[start..=end].to_vec(), kind, cache);
    response.status = 206;
    response
        .headers
        .push(("Content-Range".into(), format!("bytes {start}-{end}/{len}")));
    response
}
