//! 价目表：把 token 用量换算成钱。
//!
//! 单位统一为**人民币元 / 百万 token**：输入（缓存未命中）、输入（缓存命中）、输出三档。
//! 内置常见模型的价格，账号目录里可以放 `prices.json` 覆盖或补充：
//!
//! ```json
//! { "deepseek/deepseek-chat": { "input": 2, "cache": 0.5, "output": 8 } }
//! ```
//!
//! 价目表里没有的模型**不折算成 0**：账本把它记进 `unpriced`，页面照实说「没价」。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// 一个模型的三档单价（元 / 百万 token）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Price {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub cache: f64,
    #[serde(default)]
    pub output: f64,
}

/// 内置价目表：键是台账里记的 `服务商/模型`。数字按各家公开价（2026 年，元 / 百万 token），
/// 变了就在账号目录的 `prices.json` 里覆盖，不用改代码。
fn builtin() -> BTreeMap<String, Price> {
    let mut table = BTreeMap::new();
    // DeepSeek 开放平台：缓存未命中 2 元、命中 0.5 元、输出 8 元
    table.insert(
        "deepseek/deepseek-chat".into(),
        Price {
            input: 2.0,
            cache: 0.5,
            output: 8.0,
        },
    );
    // DeepSeek 推理模型：缓存未命中 4 元、命中 1 元、输出 16 元
    table.insert(
        "deepseek/deepseek-reasoner".into(),
        Price {
            input: 4.0,
            cache: 1.0,
            output: 16.0,
        },
    );
    table
}

/// 一份价目表：内置的，加上账号目录里的覆盖。
pub struct Table {
    prices: BTreeMap<String, Price>,
}

/// 账号目录里的价目表文件。
pub fn file(home: &Path) -> std::path::PathBuf {
    home.join("prices.json")
}

/// 读价目表。文件不在、读坏了、某一项写错了，都不影响其余项照用。
pub fn table(home: &Path) -> Table {
    let mut prices = builtin();
    if let Ok(Value::Object(overridden)) = crate::storage::read_json(&file(home)) {
        for (key, value) in overridden {
            if let Ok(price) = serde_json::from_value::<Price>(value) {
                prices.insert(key, price);
            }
        }
    }
    Table { prices }
}

impl Table {
    /// 台账里记的是 `服务商/模型`；也认只写模型名的键（同一个模型挂在不同服务商下时省事），
    /// 反过来只写模型名去查 `服务商/模型` 也认。
    pub fn price_of(&self, model: Option<&str>) -> Option<Price> {
        let model = model?;
        if let Some(price) = self.prices.get(model) {
            return Some(*price);
        }
        match model.split_once('/') {
            Some((_, name)) => self.prices.get(name).copied(),
            None => self
                .prices
                .iter()
                .find(|(key, _)| key.rsplit_once('/').map(|(_, name)| name) == Some(model))
                .map(|(_, price)| *price),
        }
    }

    /// 这一次请求花多少：微元（元 × 1 000 000）的整数，免得浮点加着加着漂。
    /// `input` 含缓存命中的部分，命中部分按 `cache` 价算。
    pub fn cost_micros(&self, model: Option<&str>, input: u64, cache: u64, output: u64) -> Option<u64> {
        let price = self.price_of(model)?;
        let hit = cache.min(input);
        let miss = input - hit;
        let total = miss as f64 * price.input + hit as f64 * price.cache + output as f64 * price.output;
        // 单价是「元 / 百万 token」，乘上 token 数正好就是微元
        Some(total.round().max(0.0) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!("town-prices-{}", crate::token()));
        std::fs::create_dir_all(&home).expect("建临时目录");
        home
    }

    /// 内置价目表按量算钱：缓存命中的那部分按便宜的价
    #[test]
    fn a_model_in_the_table_is_priced_by_its_three_rates() {
        let table = table(&temp_home());
        // 1M 输入（其中 400k 命中）+ 200k 输出
        let cost = table
            .cost_micros(Some("deepseek/deepseek-chat"), 1_000_000, 400_000, 200_000)
            .expect("有价");
        // 600k × 2 元 + 400k × 0.5 元 + 200k × 8 元 = 1.2 + 0.2 + 1.6 = 3 元 → 3 000 000 微元
        assert_eq!(cost, 3_000_000);
        // 只写模型名也认
        assert!(table.price_of(Some("deepseek-chat")).is_some());
        // 价目表里没有的模型：不是 0，是「不知道」
        assert_eq!(table.cost_micros(Some("mock/agent-wiring-fixture"), 1, 0, 1), None);
        assert_eq!(table.cost_micros(None, 1, 0, 1), None);
    }

    /// 账号目录里的 prices.json 能覆盖内置价，也能加新模型；写坏的项不影响别的项
    #[test]
    fn an_account_can_override_prices_without_touching_the_code() {
        let home = temp_home();
        crate::storage::write_json(
            &file(&home),
            &serde_json::json!({
                "deepseek/deepseek-chat": { "input": 1.0, "cache": 0.1, "output": 2.0 },
                "my/own-model": { "input": 10.0, "cache": 1.0, "output": 30.0 },
                "broken": "不是对象"
            }),
        )
        .expect("写价目表");
        let table = table(&home);
        assert_eq!(
            table.cost_micros(Some("deepseek/deepseek-chat"), 1_000_000, 0, 0),
            Some(1_000_000)
        );
        assert_eq!(
            table.cost_micros(Some("my/own-model"), 0, 0, 1_000_000),
            Some(30_000_000)
        );
        // 写坏的那项被跳过，内置的 deepseek-reasoner 还在
        assert!(table.price_of(Some("deepseek/deepseek-reasoner")).is_some());
    }
}
