//! 现实时间锚点：世界以模拟分钟推进，但存档要能说明它落在哪个真实时刻、按哪个时区显示。
//! 只记录锚点与上次保存时刻；读档不补算离线时间，避免把没人看的世界凭空推进。
use crate::HostError;
use jiff::{tz::TimeZone, Timestamp};
use serde::{Deserialize, Serialize};

pub const DEFAULT_TIMEZONE: &str = "Asia/Shanghai";

fn default_timezone() -> String {
    DEFAULT_TIMEZONE.into()
}

/// 随存档保存的时钟状态；旧档没有时按默认时区、无锚点读入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClockSave {
    #[serde(default = "default_timezone")]
    pub timezone: String,
    /// 上一次成功存盘对应的 UTC 时刻（RFC 3339）；新世界还没有存过时为 None。
    #[serde(default)]
    pub last_saved_utc: Option<String>,
    /// 上一次成功存盘时的模拟分钟，用来核对锚点是否和世界一起前进。
    #[serde(default)]
    pub last_saved_minutes: f64,
    /// 上一次启动与上次存盘之间的现实间隔；只在读档时计算并保留，作为重启缺口的记录。
    #[serde(default)]
    pub restart_gap_seconds: u64,
}

impl Default for ClockSave {
    fn default() -> Self {
        Self {
            timezone: default_timezone(),
            last_saved_utc: None,
            last_saved_minutes: 0.0,
            restart_gap_seconds: 0,
        }
    }
}

impl ClockSave {
    pub fn new(timezone: Option<String>) -> Self {
        Self {
            timezone: timezone.unwrap_or_else(default_timezone),
            ..Self::default()
        }
    }

    /// IANA 时区名必须能被时区库识别；已有锚点必须是合法 RFC 3339。
    pub fn validate(&self) -> Result<(), HostError> {
        TimeZone::get(&self.timezone).map_err(|e| {
            HostError::Config(format!("时区 {} 不是有效的 IANA 时区：{e}", self.timezone))
        })?;
        if let Some(anchor) = &self.last_saved_utc {
            anchor
                .parse::<Timestamp>()
                .map_err(|e| HostError::Config(format!("存档里的 UTC 锚点 {anchor} 无效：{e}")))?;
        }
        if !self.last_saved_minutes.is_finite() || self.last_saved_minutes < 0.0 {
            return Err(HostError::Save("存档里的时钟模拟分钟无效".into()));
        }
        Ok(())
    }

    /// 读档时补上重启缺口，但不改动世界时间。
    pub fn after_restart(mut self) -> Self {
        if let Some(anchor) = self
            .last_saved_utc
            .as_deref()
            .and_then(|s| s.parse::<Timestamp>().ok())
        {
            let gap = Timestamp::now()
                .as_second()
                .saturating_sub(anchor.as_second());
            self.restart_gap_seconds = u64::try_from(gap.max(0)).unwrap_or(u64::MAX);
        }
        self
    }

    /// 存盘前落锚：记录这一份存档对应的真实时刻与模拟分钟。
    pub fn stamped(&self, sim_minutes: f64) -> Self {
        Self {
            last_saved_utc: Some(Timestamp::now().to_string()),
            last_saved_minutes: sim_minutes,
            ..self.clone()
        }
    }

    /// 当前时刻按世界时区显示，供启动日志和后台诊断使用。
    pub fn local_now(&self) -> Result<String, HostError> {
        let zone = TimeZone::get(&self.timezone).map_err(|e| {
            HostError::Config(format!("时区 {} 不是有效的 IANA 时区：{e}", self.timezone))
        })?;
        Ok(Timestamp::now().to_zoned(zone).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_timezone_and_bad_anchor() {
        let bad_zone = ClockSave::new(Some("Mars/Olympus".into()));
        assert!(bad_zone.validate().is_err());
        let bad_anchor = ClockSave {
            last_saved_utc: Some("not-a-time".into()),
            ..ClockSave::default()
        };
        assert!(bad_anchor.validate().is_err());
    }

    #[test]
    fn restart_gap_is_recorded_without_moving_world_time() {
        let anchor = Timestamp::from_second(Timestamp::now().as_second() - 125)
            .unwrap()
            .to_string();
        let clock = ClockSave {
            last_saved_utc: Some(anchor),
            last_saved_minutes: 420.0,
            ..ClockSave::default()
        };
        let restarted = clock.after_restart();
        assert!((125..=127).contains(&restarted.restart_gap_seconds));
        assert_eq!(restarted.last_saved_minutes, 420.0);
    }
}
