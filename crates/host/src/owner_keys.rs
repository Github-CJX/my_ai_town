//! 村民用自己的密钥：投他进镇的那个账号填的服务商、服务地址与密钥。
//! 只存在内存里——世界存档不写密钥（存了就等于把别人的密钥抄进小镇存档）；
//! 世界重启后由管理服务重发，收回这位村民时随之丢掉。
//! 纪律照旧：密钥不进日志、不进广播，回执只说一句人话。

use std::collections::BTreeMap;

/// 一位村民账号里的那一把密钥；`base_url` 为空表示沿用世界配置里的地址。
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct OwnerKey {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Default)]
pub(crate) struct OwnerKeys {
    keys: BTreeMap<String, OwnerKey>,
}

impl OwnerKeys {
    pub(crate) fn set(&mut self, resident: &str, key: OwnerKey) {
        self.keys.insert(resident.into(), key);
    }

    /// 这位村民自己的那一把（服务商对不上就没有）；空密钥当作没有。
    pub(crate) fn get(&self, resident: &str, provider: &str) -> Option<&OwnerKey> {
        self.keys
            .get(resident)
            .filter(|key| key.provider == provider && !key.api_key.trim().is_empty())
    }

    pub(crate) fn forget(&mut self, resident: &str) {
        self.keys.remove(resident);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.keys.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(provider: &str, api_key: &str) -> OwnerKey {
        OwnerKey {
            provider: provider.into(),
            base_url: String::new(),
            api_key: api_key.into(),
        }
    }

    #[test]
    fn only_the_matching_provider_with_a_real_key_counts() {
        let mut keys = OwnerKeys::default();
        keys.set("a", key("deepseek", "sk-a"));
        assert_eq!(
            keys.get("a", "deepseek").map(|k| k.api_key.as_str()),
            Some("sk-a")
        );
        // 服务商对不上：还是用世界上那份，不能把 deepseek 的密钥发给别人
        assert!(keys.get("a", "openai").is_none());
        assert!(keys.get("b", "deepseek").is_none());
        // 空密钥等于没填
        keys.set("c", key("deepseek", "  "));
        assert!(keys.get("c", "deepseek").is_none());
        keys.forget("a");
        assert_eq!(keys.len(), 1);
        assert!(keys.get("a", "deepseek").is_none());
    }
}
