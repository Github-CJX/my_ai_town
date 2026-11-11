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
    if !host_allowed(app, req.header("host").unwrap_or_default()) {
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

/// 请求的 Host 里那台主机：去掉端口，IPv6 去掉方括号。
fn host_name(host: &str) -> &str {
    match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(rest),
        None => host.split(':').next().unwrap_or(host),
    }
}

/// 这个请求的 Host 能不能用：缺省只认本机；管理服务对外监听时再认 IP、监听地址和允许的域名。
/// 只认 IP 与显式允许的名字，是为了不让别人的域名解析到这台机器上就能用接口（DNS 重绑定）。
fn host_allowed(app: &App, host: &str) -> bool {
    allowed_host(&app.options.bind, app.options.allow_host.as_deref(), host)
}

fn allowed_host(bind: &str, allow_host: Option<&str>, host: &str) -> bool {
    let name = host_name(host);
    if crate::is_loopback(name) {
        return true;
    }
    if crate::is_loopback(bind) {
        return false;
    }
    name.parse::<std::net::IpAddr>().is_ok() || name == bind || allow_host == Some(name)
}

/// 页面拿到的世界地址：主机换成本次请求用的那台（世界端口不变），套了 TLS 时给 wss。
fn public_endpoint(req: &Request, endpoint: &str) -> String {
    let secure = req
        .header("x-forwarded-proto")
        .is_some_and(|value| value.eq_ignore_ascii_case("https"));
    published_endpoint(req.header("host").unwrap_or_default(), secure, endpoint)
}

fn published_endpoint(host: &str, secure: bool, endpoint: &str) -> String {
    let name = host_name(host);
    if name.is_empty() || crate::is_loopback(name) {
        return endpoint.to_owned();
    }
    let Some((scheme, rest)) = endpoint.split_once("://") else {
        return endpoint.to_owned();
    };
    let Some((authority, tail)) = rest.split_once('/') else {
        return endpoint.to_owned();
    };
    // authority 是 127.0.0.1:端口：端口留着，主机换成页面访问用的那个
    let port = authority
        .rsplit_once(':')
        .map(|(_, port)| port)
        .unwrap_or("");
    let scheme = if secure { "wss" } else { scheme };
    let authority = if port.is_empty() {
        name.to_owned()
    } else {
        format!("{name}:{port}")
    };
    format!("{scheme}://{authority}/{tail}")
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

/// 请一位村民进镇：重试时操作编号跟着换，谓词一起换。
fn join_town(app: &App, town: &str, command: &Value, op_id: &str) -> Result<Value, ApiError> {
    app.hosts
        .query_in(
            town,
            Some(command),
            |m| {
                (m["type"] == "resident_joined" && m["outcome"]["op_id"] == op_id)
                    || (m["type"] == "join_result" && m["op_id"] == op_id)
            },
            20,
        )
        .map_err(|error| {
            if error.status == 400 {
                ApiError::new(409, error.message)
            } else {
                error
            }
        })
}

/// 把账号里的整份人设写进这个镇的村民库，返回（模板编号，版本）。
/// 镇上那份还在、人也没改过 → 直接用；改过一版 → 按镇上当前版本重写；不在 → 新建一份。
fn materialize(
    app: &App,
    town: &str,
    agent: &crate::agents::Agent,
    cards: &[Value],
) -> Result<(String, u32), ApiError> {
    let Some(fields) = agent.fields.clone() else {
        return Err(ApiError::bad("这份定义里没有带着人设"));
    };
    let known = agent.template_in(town).cloned();
    let current = known.as_ref().and_then(|known| {
        cards
            .iter()
            .find(|card| card["template_id"] == known.template_id.as_str())
            .cloned()
    });
    if let (Some(known), Some(card)) = (&known, &current) {
        if known.revision == agent.revision
            && card["version"].as_u64() == Some(known.version as u64)
        {
            return Ok((known.template_id.clone(), known.version));
        }
    }
    // 重写用的是镇上那份模板现在的版本号：有人在镇里改过它，也不会把人的改动盖掉
    let request_id = format!("template-{}-{}", agent.id, crate::token());
    let mut command = json!({
        "type": "save_resident_template",
        "request_id": request_id.clone(),
        "fields": fields,
    });
    if let (Some(known), Some(card)) = (&known, &current) {
        command["template_id"] = Value::from(known.template_id.clone());
        if let Some(version) = card["version"].as_u64() {
            command["expected_version"] = Value::from(version);
        }
    }
    let reply = app.hosts.query_in(
        town,
        Some(&command),
        |m| m["type"] == "template_saved" && m["request_id"] == request_id.as_str(),
        20,
    )?;
    if reply["ok"].as_bool() != Some(true) {
        return Err(ApiError::new(
            409,
            reply["message"]
                .as_str()
                .unwrap_or("镇上写不进这份人设")
                .to_owned(),
        ));
    }
    let template_id = reply["template"]["template_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let version = reply["template"]["version"].as_u64().unwrap_or(0) as u32;
    if template_id.is_empty() {
        return Err(ApiError::new(409, "镇上没给新模板的编号"));
    }
    Ok((template_id, version))
}

/// 把某位村民的密钥交给世界：世界只记在内存里，回执只有一句人话。
fn hand_key(
    app: &App,
    town: &str,
    resident: &str,
    api: &accounts::ApiAccount,
) -> Result<(), ApiError> {
    let request_id = format!("key-{}-{}", resident, crate::token());
    let command = json!({
        "type": "set_resident_key",
        "request_id": request_id.clone(),
        "resident": resident,
        "provider": api.provider,
        "base_url": api.base_url,
        "api_key": api.api_key,
    });
    let reply = app.hosts.query_in(
        town,
        Some(&command),
        |m| m["type"] == "resident_key_saved" && m["request_id"] == request_id.as_str(),
        5,
    )?;
    if reply["ok"].as_bool() == Some(true) {
        return Ok(());
    }
    Err(ApiError::new(
        409,
        reply["message"]
            .as_str()
            .unwrap_or("世界没有收下密钥")
            .to_owned(),
    ))
}

/// 世界一重新拉起来，内存里的密钥就没了：按账号把投在这个镇里的 agent 再送一遍。
/// 每日额度也一起补一遍——世界重启后存档里还在，重置过的镇就没有了。
/// 送不进去只记一行日志——世界照常跑，村民会先等着，人还能再投一次。
pub(crate) fn resend_keys(app: &App, town: &str) {
    let prepared = {
        let accounts = app.accounts.lock().unwrap();
        accounts
            .list()
            .iter()
            .map(|user| {
                let home = accounts.home(&user.id);
                let api = accounts.api(&app.config, user).ok().flatten();
                (
                    user.name.clone(),
                    crate::agents::list(&home).unwrap_or_default(),
                    api,
                    home,
                )
            })
            .collect::<Vec<_>>()
    };
    for (who, agents, api, home) in prepared {
        let budget = crate::usage::read(&home);
        if budget.calls_per_day.is_some() || budget.tokens_per_day.is_some() {
            if let Err(error) = crate::usage::push(&app.hosts, town, &agents, &budget) {
                eprintln!(
                    "[town-manager] 重发「{who}」的每日额度没成功：{}",
                    error.message
                );
            }
        }
        let Some(api) = api else { continue };
        for agent in agents {
            let Some(record) = agent.deployed_in(town) else {
                continue;
            };
            if let Err(error) = hand_key(app, town, &record.resident, &api) {
                eprintln!(
                    "[town-manager] 给「{}」重发密钥没成功：{}",
                    agent.name, error.message
                );
            }
        }
    }
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
        // 账号自己的 agent：定义放在账号目录里，投进哪个小镇是下面 /:id/deploy 那一步
        (true, "/agents") => {
            let home = app.accounts.lock().unwrap().home(&me.id);
            let agents: Vec<Value> = crate::agents::list(&home)?
                .iter()
                .map(crate::agents::Agent::public)
                .collect();
            return ok(json!({ "agents": agents, "limit": me.agent_limit }));
        }
        (false, "/agents") => {
            let home = app.accounts.lock().unwrap().home(&me.id);
            let agent = crate::agents::create(&home, &body(req)?, me.agent_limit)?;
            return ok(json!({ "ok": true, "agent": agent.public() }));
        }
        (false, "/agents/delete") => {
            let home = app.accounts.lock().unwrap().home(&me.id);
            let request = body(req)?;
            crate::agents::remove(&home, request["id"].as_str().unwrap_or_default())?;
            return ok(json!({ "ok": true }));
        }
        // 改定义：人设、长相、落脚点。已经投出去的那位不会跟着变，收回再投才更新
        (false, "/agents/update") => {
            let home = app.accounts.lock().unwrap().home(&me.id);
            let agent = crate::agents::update(&home, &body(req)?)?;
            return ok(json!({ "ok": true, "agent": agent.public() }));
        }
        // 今天用了多少：世界按居民记，这里换回账号的 agent 再加起来
        (true, "/usage") => {
            let home = app.accounts.lock().unwrap().home(&me.id);
            return ok(crate::usage::summary(&app.hosts, &app.storage, &home)?);
        }
        // 账号自己的每日额度：存下来，顺手发给正在跑的小镇
        (false, "/budget") => {
            let home = app.accounts.lock().unwrap().home(&me.id);
            let budget = crate::usage::save(&home, &body(req)?)?;
            let agents = crate::agents::list(&home)?;
            let mut notes = Vec::new();
            let mut towns = std::collections::BTreeSet::new();
            for agent in &agents {
                towns.extend(agent.deployed.keys().cloned());
            }
            for town in towns {
                if !app.hosts.is_running(&town) {
                    continue;
                }
                if let Err(error) = crate::usage::push(&app.hosts, &town, &agents, &budget) {
                    notes.push(format!(
                        "「{}」还没接受这个额度（{}）",
                        app.storage.name(&town),
                        error.message
                    ));
                }
            }
            return ok(json!({ "ok": true, "budget": budget, "notes": notes }));
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
            let mut info = app.hosts.open(&app.storage, id, &user_config(app, &me)?)?;
            // 世界重启后密钥没了：把这个镇里已投放的 agent 再送一遍
            resend_keys(app, id);
            // 页面在世界自己的端口上连；从别的机器访问时主机名要换成它们能连的那个
            let endpoint = public_endpoint(req, info["endpoint"].as_str().unwrap_or_default());
            info["endpoint"] = Value::from(endpoint);
            ok(info)
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
            resend_keys(app, id);
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
            let endpoint = public_endpoint(req, info["endpoint"].as_str().unwrap_or_default());
            info["endpoint"] = Value::from(endpoint);
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
        // 这个镇现在收得下谁：正在跑的世界给一份还能用的模板（投放时从这里挑）
        (true, "templates") => {
            if !app.hosts.is_running(id) {
                return Err(ApiError::new(
                    409,
                    "这个小镇没在运行：先进一次，或让它在后台运行",
                ));
            }
            let library =
                app.hosts
                    .query(id, Some(&json!({ "type": "get_resident_library" })), |m| {
                        m["type"] == "resident_library"
                    })?;
            let templates: Vec<Value> = library["templates"]
                .as_array()
                .map(|cards| {
                    cards
                        .iter()
                        .filter(|card| card["status"] == "available")
                        .map(|card| {
                            json!({
                                "template_id": card["template_id"],
                                "version": card["version"],
                                "name": card["name"],
                                "intro": card["intro"],
                                "tags": card["tags"],
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            ok(json!({ "templates": templates }))
        }
        // 首页建村民时用：按字段渲染人设全文（世界那边是纯函数，不落盘）
        (false, "persona") => {
            let request = body(req)?;
            if !app.hosts.is_running(id) {
                return Err(ApiError::new(
                    409,
                    "这个小镇没在运行：先进一次，或让它在后台运行，才能预览人设",
                ));
            }
            let command = json!({
                "type": "preview_template_persona",
                "fields": request["fields"],
            });
            let reply = app
                .hosts
                .query(id, Some(&command), |m| m["type"] == "template_persona")?;
            ok(json!({ "persona": reply["persona"], "error": reply["error"] }))
        }
        // 首页建村民时用：世界的工具模型按一句话描述生成一整份人设
        (false, "generate") => {
            let request = body(req)?;
            if !app.hosts.is_running(id) {
                return Err(ApiError::new(
                    409,
                    "这个小镇没在运行：先进一次，或让它在后台运行，才能用模型生成",
                ));
            }
            let request_id = format!("generate-{}", crate::token());
            let command = json!({
                "type": "generate_resident_template",
                "request_id": request_id.clone(),
                "brief": request["brief"],
            });
            let reply = app.hosts.query_in(
                id,
                Some(&command),
                |m| m["type"] == "template_generated" && m["request_id"] == request_id.as_str(),
                120,
            )?;
            ok(json!({
                "ok": reply["ok"],
                "message": reply["message"],
                "fields": reply["fields"],
            }))
        }
        // 手动投放：把账号里这份定义请进这个镇。世界不自动收人，必须由人点这一下。
        (false, "deploy") => {
            let request = body(req)?;
            let home = app.accounts.lock().unwrap().home(&me.id);
            let mut agent =
                crate::agents::read(&home, request["agent_id"].as_str().unwrap_or_default())?;
            if agent.deployed_in(id).is_some() {
                return Err(ApiError::new(409, "这个 agent 已经在这个镇里了"));
            }
            if !app.hosts.is_running(id) {
                return Err(ApiError::new(
                    409,
                    "这个小镇没在运行：先进一次，或让它在后台运行",
                ));
            }
            // 世界观没设好的世界还不收人：先说清楚缺哪一步，别让世界回一句「请先设置世界观」
            let state = app
                .hosts
                .observe(id)
                .ok_or_else(|| ApiError::new(409, "这个小镇正在拉起来，稍等一会儿再试"))?;
            if !state["ready"].as_bool().unwrap_or(false) {
                return Err(ApiError::new(
                    409,
                    "这个小镇还没设定世界观：先进镇里设定一次，再投放",
                ));
            }
            let population =
                app.hosts
                    .query(id, Some(&json!({ "type": "get_population" })), |m| {
                        m["type"] == "population"
                    })?;
            let view = &population["population"];
            let people = view["residents"].as_array().cloned().unwrap_or_default();
            if people
                .iter()
                .any(|person| person["name"] == agent.name.as_str())
            {
                return Err(ApiError::new(
                    409,
                    format!("镇上已经有叫「{}」的居民了，换一个名字再投", agent.name),
                ));
            }
            let library =
                app.hosts
                    .query(id, Some(&json!({ "type": "get_resident_library" })), |m| {
                        m["type"] == "resident_library"
                    })?;
            let cards = library["templates"].as_array().cloned().unwrap_or_default();
            // 新形状：定义里带着整份人设，投放时在镇上写一份模板（人改过一版就重写）
            let (template_id, template_version) = if agent.fields.is_some() {
                let (template_id, version) = materialize(app, id, &agent, &cards)?;
                crate::agents::record_template(&home, &mut agent, id, &template_id, version)?;
                (template_id, version)
            } else {
                // 老形状：定义只记着某个镇的模板，那份模板得还在、并且还没人占用
                let usable = cards.iter().any(|card| {
                    card["template_id"] == agent.template_id.as_str()
                        && card["version"].as_u64() == Some(agent.template_version as u64)
                        && card["status"] == "available"
                });
                if !usable {
                    return Err(ApiError::new(
                        409,
                        "这个镇没有这个模板（或者它已经在用了）：换个模板，或在这个镇重新建一个 agent",
                    ));
                }
                (agent.template_id.clone(), agent.template_version)
            };
            let op_id = format!("agent-{}-{}", agent.id, crate::token());
            // 他自己账号的模型与密钥：投出去的村民用他自己的，不再花世界的额度
            let api = app.accounts.lock().unwrap().api(&app.config, &me)?;
            let mut command = json!({
                "type": "join_resident",
                "op_id": op_id,
                "world_id": view["world_id"],
                "template_id": template_id,
                "template_version": template_version,
                "name": agent.name,
            });
            if let Some(api) = &api {
                command["model"] = json!({ "provider": api.provider, "model": api.model });
            }
            // 想住的落脚点在那个镇存在才填：没有就按世界自己安排
            if let Some(wanted) = &agent.home {
                let exists = view["homes"].as_array().is_some_and(|homes| {
                    homes.iter().any(|home| home["locale"] == wanted.as_str())
                });
                if exists {
                    command["home"] = Value::from(wanted.clone());
                }
            }
            let mut reply = join_town(app, id, &command, &op_id)?;
            // 世界的服务商名单里没有他账号里选的那家（他自己加过一个服务商）：先让他进来等着，
            // 别因为这一句就把人挡在门外
            let mut stranger = false;
            if reply["outcome"]["ok"].as_bool() != Some(true)
                && api.is_some()
                && reply["outcome"]["message"]
                    .as_str()
                    .is_some_and(|text| text.contains("模型服务尚未配置"))
            {
                stranger = true;
                if let Some(fields) = command.as_object_mut() {
                    fields.remove("model");
                }
                let retry = format!("{op_id}-plain");
                command["op_id"] = Value::from(retry.clone());
                reply = join_town(app, id, &command, &retry)?;
            }
            let outcome = &reply["outcome"];
            if outcome["ok"].as_bool() != Some(true) {
                let message = outcome["message"]
                    .as_str()
                    .unwrap_or("没能把这个 agent 投进去");
                return Err(ApiError::new(409, message));
            }
            let resident = outcome["resident_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let name = outcome["name"].as_str().unwrap_or(&agent.name).to_owned();
            // 密钥随后单独送一次：只在内存里，世界的存盘里没有它
            let mut note = if stranger {
                format!(
                    "这个镇还不认识他账号里选的服务商（{}）：人已经投进去了，会先在镇上等着。把这家服务商加进小镇的名单之后，收回他再投一次",
                    api.as_ref().map(|a| a.provider.as_str()).unwrap_or_default()
                )
            } else {
                match &api {
                    Some(api) => match hand_key(app, id, &resident, api) {
                        Ok(()) => String::new(),
                        Err(error) => format!(
                            "他已经在镇上了，但密钥没送到世界那边（{}）：先让他等着，过一会儿再投放一次",
                            error.message
                        ),
                    },
                    None => String::from(
                        "他这个账号还没选好模型和密钥：人已经投进去了，会先在镇上等着。你在「设定 · 账号」里配好之后，收回他再投一次",
                    ),
                }
            };
            crate::agents::record_deploy(&home, &mut agent, id, &resident, &name)?;
            // 他自己设过每日额度的话，跟着发给镇上这位居民（世界按居民记，投别人不受影响）
            let budget = crate::usage::read(&home);
            if budget.calls_per_day.is_some() || budget.tokens_per_day.is_some() {
                if let Err(error) =
                    crate::usage::push(&app.hosts, id, std::slice::from_ref(&agent), &budget)
                {
                    if !note.is_empty() {
                        note.push('；');
                    }
                    note.push_str(&format!(
                        "他自己的每日额度没送到世界那边（{}）：先按全镇额度算",
                        error.message
                    ));
                }
            }
            let mut result = json!({ "ok": true, "agent": agent.public() });
            if !note.is_empty() {
                result["note"] = Value::from(note);
            }
            ok(result)
        }
        // 收回：请投放出去的那一位离开这个镇，并把这里的投放记录抹掉
        (false, "withdraw") => {
            let request = body(req)?;
            let home = app.accounts.lock().unwrap().home(&me.id);
            let mut agent =
                crate::agents::read(&home, request["agent_id"].as_str().unwrap_or_default())?;
            let Some(record) = agent.deployed_in(id).cloned() else {
                return Err(ApiError::new(409, "这个 agent 不在这个镇里"));
            };
            if !app.hosts.is_running(id) {
                return Err(ApiError::new(
                    409,
                    "这个小镇没在运行：先进一次，或让它在后台运行，才收得回来",
                ));
            }
            let request_id = format!("withdraw-{}-{}", agent.id, crate::token());
            let reply = app
                .hosts
                .query_in(
                    id,
                    Some(&json!({
                        "type": "remove_resident",
                        "request_id": request_id,
                        "resident": record.resident,
                    })),
                    |m| m["type"] == "resident_removed" && m["request_id"] == request_id.as_str(),
                    20,
                )
                .map_err(|error| {
                    if error.status == 400 {
                        ApiError::new(409, error.message)
                    } else {
                        error
                    }
                })?;
            if reply["ok"].as_bool() != Some(true) {
                let message = reply["message"]
                    .as_str()
                    .unwrap_or("没能请他离开")
                    .to_owned();
                // 世界那边本来就没这个人了（重置过、或存档换过）：记录跟着清掉，不然这个 agent 永远删不掉
                if message.contains("名册里没有") {
                    crate::agents::record_withdraw(&home, &mut agent, id)?;
                    return ok(json!({ "ok": true, "agent": agent.public(), "note": message }));
                }
                return Err(ApiError::new(409, message));
            }
            crate::agents::record_withdraw(&home, &mut agent, id)?;
            let message = reply["message"]
                .as_str()
                .unwrap_or("已经离开了小镇")
                .to_owned();
            ok(json!({ "ok": true, "agent": agent.public(), "message": message }))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_configured_addresses_are_accepted() {
        // 只在本机用时，别的 Host 一律不认
        assert!(allowed_host("127.0.0.1", None, "localhost:8788"));
        assert!(!allowed_host("127.0.0.1", None, "192.0.2.10:8788"));
        // 对外监听之后：IP 可以，别人的域名仍然不行
        assert!(allowed_host("0.0.0.0", None, "192.0.2.10:8788"));
        assert!(!allowed_host("0.0.0.0", None, "town.example.com"));
        assert!(allowed_host(
            "0.0.0.0",
            Some("town.example.com"),
            "town.example.com"
        ));
    }

    #[test]
    fn the_page_gets_an_endpoint_it_can_reach() {
        let local = "ws://127.0.0.1:9123/?session=abc";
        assert_eq!(published_endpoint("127.0.0.1:8788", false, local), local);
        assert_eq!(
            published_endpoint("192.0.2.10:8788", false, local),
            "ws://192.0.2.10:9123/?session=abc"
        );
        assert_eq!(
            published_endpoint("town.example.com", true, local),
            "wss://town.example.com:9123/?session=abc"
        );
    }
}
