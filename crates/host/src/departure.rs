//! 请一位村民离开小镇：名册、会话、互动、随身东西、住宅一起收干净，存盘失败整体回退。
//! 世界只留一句「离开了小镇」，他的经历和记忆不进这里；投放他的账号想再让他来，重新投放一次即可。
use crate::network::Clients;
use crate::runtime::{Outcome, Runtime};
use protocol::ServerMsg;

impl Runtime {
    /// 收回一位村民：先核对名册，再在事务里收尾。
    pub(crate) fn remove_resident(
        &mut self,
        request_id: String,
        resident: &str,
        clients: &Clients,
    ) -> Outcome {
        if !self.population.residents.contains_key(resident) {
            return Outcome::reply(ServerMsg::ResidentRemoved {
                request_id,
                ok: false,
                message: "名册里没有这位村民（可能已经离开了，或者页面还没刷新）".into(),
            });
        }
        let name = match self.transact(|rt| rt.depart(resident)) {
            Ok(name) => name,
            Err(aborted) => {
                let message = format!("没能请他离开：{aborted}");
                eprintln!("[host] 收回 {resident} 失败：{message}");
                return Outcome::reply(ServerMsg::ResidentRemoved {
                    request_id,
                    ok: false,
                    message,
                });
            }
        };
        let message = format!("「{name}」已经离开了小镇");
        println!("[host] {message}");
        // 他走了就把他的密钥一起丢掉：留在内存里也没人用了
        self.owner_keys.forget(resident);
        // 世界日志立刻发出去：镇子停着不动的时候，留下的村民也能看到这句
        let events = self.world.take_events();
        self.driver.dispatch(&self.world, events, clients);
        Outcome::none()
            .and_reply(ServerMsg::ResidentRemoved {
                request_id,
                ok: true,
                message: message.clone(),
            })
            .and_all(self.population_msg())
            .and_all(crate::runtime::event(&self.world, &message))
    }

    /// 事务里的那一步：丢掉会话 → 世界收尾 → 名册少一人。
    /// 顺序要紧：会话要先删（它可能还挂着在途请求），世界的互动要在人还在的时候收。
    fn depart(&mut self, resident: &str) -> Result<String, String> {
        self.driver.runtime.forget(resident);
        let name = self
            .world
            .leave(resident)
            .map_err(|error| error.to_string())?;
        self.population.residents.remove(resident);
        self.population.revision = self.population.revision.wrapping_add(1);
        Ok(name)
    }
}
