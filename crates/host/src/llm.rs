//! 模型 HTTP 通道——除了下载内置模型（builtin_store.rs），整个工程里只有这里碰网络（内置模型连本机的服务，
//! 见 builtin.rs）。只管发送与接收：请求正文、回复解析和错误分类在 agent::completion。
//! OpenAI 兼容传输：一条 HTTP 代码覆盖整个服务商目录。
//! 同步阻塞，由有界线程池调用，不引入 tokio。
//!
//! 纪律：密钥只在 LlmTarget 内存里与请求头里出现，永不进日志、广播或回读。

use crate::config::{Credentials, ProvidersFile};
use agent::completion::{self, ModelError};
use std::io::Read;
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct LlmTarget {
    pub provider: String,
    pub model: String,
    /// 服务地址；内置模型是模型目录。
    pub base_url: String,
    pub api_key: Option<String>,
}

impl LlmTarget {
    /// 按配置里的服务商与模型名拼出调用目标；服务商不在配置里时为 None。
    pub fn configured(
        providers: &ProvidersFile,
        credentials: &Credentials,
        provider: &str,
        model: &str,
    ) -> Option<Self> {
        let entry = providers.providers.iter().find(|p| p.id == provider)?;
        Some(Self {
            provider: provider.into(),
            model: model.into(),
            base_url: entry.base_url.clone(),
            api_key: credentials.get(provider).cloned(),
        })
    }
    /// 设定中心选的小镇工具模型；没选或服务商不存在时为 None。
    pub fn active(providers: &ProvidersFile, credentials: &Credentials) -> Option<Self> {
        let active = providers.active.as_ref()?;
        Self::configured(providers, credentials, &active.provider, &active.model)
    }
    /// 用这位村民自己账号里的密钥与地址；地址为空时沿用世界配置里的地址。
    /// 服务商在世界配置里、账号里也写了地址，都行；两处都没有地址就调不了。
    pub fn with_own_key(
        providers: &ProvidersFile,
        provider: &str,
        model: &str,
        base_url: &str,
        api_key: &str,
    ) -> Option<Self> {
        let configured = providers
            .providers
            .iter()
            .find(|p| p.id == provider)
            .map(|p| p.base_url.clone());
        let base_url = Some(base_url.trim())
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .or(configured)?;
        Some(Self {
            provider: provider.into(),
            model: model.into(),
            base_url,
            api_key: Some(api_key.into()),
        })
    }
}

/// 只有一条 user 消息的补全：连接测试、生成人物、规划地图。请求正文与回复解析在 agent::completion。
pub fn chat_completion(t: &LlmTarget, prompt: &str) -> Result<String, ModelError> {
    let response = post_completion(t, &completion::prompt_body(&t.model, prompt))?;
    completion::reply_text(&response)
}

/// 响应正文的字节上限。
const RESPONSE_MAX_BYTES: u64 = 256 * 1024;
/// HTTP 错误时读取的正文字节上限。
const ERROR_BODY_BYTES: u64 = 4096;

/// POST 到 {base_url}/chat/completions，返回响应 JSON。HTTP 错误的分类交给 agent::completion。
pub fn post_completion(
    t: &LlmTarget,
    body: &serde_json::Value,
) -> Result<serde_json::Value, ModelError> {
    if t.provider == crate::builtin::PROVIDER {
        return crate::builtin::complete(body);
    }
    if t.base_url.is_empty() {
        return Err(ModelError::NotSent("未配置服务商端点".into()));
    }
    let url = format!("{}/chat/completions", t.base_url.trim_end_matches('/'));
    let mut req = ureq::post(&url)
        .timeout(Duration::from_secs(300))
        .set("Content-Type", "application/json");
    if let Some(k) = &t.api_key {
        req = req.set("Authorization", &format!("Bearer {k}"));
    }
    let resp = match req.send_string(&body.to_string()) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let mut detail = String::new();
            let _ = r
                .into_reader()
                .take(ERROR_BODY_BYTES)
                .read_to_string(&mut detail);
            if let Some(key) = &t.api_key {
                detail = detail.replace(key, "[redacted]");
            }
            return Err(completion::http_error(code, &detail));
        }
        Err(ureq::Error::Transport(e)) => return Err(ModelError::Network(e.to_string())),
    };
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(RESPONSE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| ModelError::Network(format!("读取模型响应失败：{e}")))?;
    if bytes.len() as u64 > RESPONSE_MAX_BYTES {
        return Err(ModelError::Reply("模型响应超过 256 KiB 上限".into()));
    }
    serde_json::from_slice(&bytes).map_err(|e| ModelError::Reply(format!("响应不是 JSON：{e}")))
}
