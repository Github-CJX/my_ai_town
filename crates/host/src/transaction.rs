//! 「修改 → 存盘 → 失败回滚」的唯一写法。改动前快照世界（连同尚未发出的世界日志）、人口、
//! Agent 会话、化身控制、世界设定与速度；改动被拒或存盘失败时逐项恢复，每一步都执行，
//! 恢复不了的部分一并报告。
use crate::{avatar::Control, runtime::Runtime};
use host::{population::Population, world_settings::WorldSettings, HostError};
use std::collections::BTreeMap;
use std::fmt;

/// 改动前的全部可变状态。
struct Checkpoint {
    world: kernel::WorldCheckpoint,
    population: Population,
    agent: agent::runtime::ControlCheckpoint,
    avatar_controls: BTreeMap<u64, Control>,
    world_settings: WorldSettings,
    speed: f64,
}

/// 事务没有提交的原因。
pub(crate) enum Abort<E> {
    /// 改动本身被拒绝。
    Rejected(E),
    /// 改动已做完，存盘失败。
    SaveFailed(HostError),
}

/// 事务失败：原因，以及没能恢复的部分（为空表示已完整回到改动前）。
pub(crate) struct Aborted<E> {
    pub cause: Abort<E>,
    pub leftovers: Vec<String>,
}

impl<E> Aborted<E> {
    /// 没能恢复的部分的说明；完整恢复时为空串。
    pub fn leftover_note(&self) -> String {
        if self.leftovers.is_empty() {
            String::new()
        } else {
            format!(
                "；回滚失败，状态可能不一致，建议重启：{}",
                self.leftovers.join("；")
            )
        }
    }
}

impl<E: fmt::Display> fmt::Display for Aborted<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.cause {
            Abort::Rejected(error) => write!(f, "{error}")?,
            Abort::SaveFailed(error) => write!(f, "保存失败，本次修改已撤回：{error}")?,
        }
        f.write_str(&self.leftover_note())
    }
}

impl Runtime {
    /// 执行改动并存盘；任一步失败就恢复到改动前。
    pub(crate) fn transact<T, E>(
        &mut self,
        change: impl FnOnce(&mut Self) -> Result<T, E>,
    ) -> Result<T, Aborted<E>> {
        let before = self.capture();
        let cause = match change(self) {
            // 事务要「写到盘上才算数」：等这一次同步写完，失败就回滚。
            Ok(value) => match self.checkpoint_now() {
                Ok(()) => return Ok(value),
                Err(error) => Abort::SaveFailed(error),
            },
            Err(error) => Abort::Rejected(error),
        };
        let leftovers = self.restore(before);
        if !leftovers.is_empty() {
            eprintln!("[host] 回滚失败，状态可能不一致：{}", leftovers.join("；"));
        }
        Err(Aborted { cause, leftovers })
    }

    fn capture(&self) -> Checkpoint {
        Checkpoint {
            world: self.world.checkpoint(),
            population: self.population.clone(),
            agent: self.driver.runtime.control_checkpoint(),
            avatar_controls: self.avatar_controls.clone(),
            world_settings: self.world_settings.clone(),
            speed: self.speed,
        }
    }

    /// 每一项都恢复，不因前一项失败而跳过；返回没能恢复的项。
    fn restore(&mut self, before: Checkpoint) -> Vec<String> {
        let mut leftovers = Vec::new();
        if let Err(error) = self.world.restore_checkpoint(before.world) {
            leftovers.push(format!("世界：{error}"));
        }
        self.population = before.population;
        self.driver.runtime.rollback_control(before.agent);
        self.avatar_controls = before.avatar_controls;
        self.world_settings = before.world_settings;
        self.speed = before.speed;
        leftovers
    }
}
