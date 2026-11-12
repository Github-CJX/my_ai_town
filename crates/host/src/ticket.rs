//! 票根：管理服务签给页面的一张短票，世界在握手时验。
//!
//! 世界不认识账号，也不该认识：它只认管理服务用**世界口令**签过的字。口令只在世界启动时
//! 由管理服务生成、只写进进程参数（`--connection-token`），页面拿不到；页面拿到的只是
//! 一张票，票上写着「是哪个账号、是不是管理员、进哪个镇、什么时候过期」。
//!
//! 格式：`v1.<hex(JSON 票面)>.<hex(HMAC-SHA256)>`。票面用十六进制而不是 base64，只为了
//! 不引新依赖：本仓已经用 `sha2`，HMAC 的 ipad/opad 两步就够。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 一张票可以用多久：页面刷新、断线重连都在这段时间里，过期就得回小镇列表。
pub const TTL: u64 = 24 * 3600;
/// 票根最长的样子：票面 + 签名，正常远小于这个数。
const MAX_TICKET: usize = 2_048;

/// 票面。字段名短，只因为它在 URL 里。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    /// 账号 id（服务票为空）
    #[serde(default)]
    pub u: String,
    /// 是管理员
    #[serde(default)]
    pub a: bool,
    /// 管理员放开的「附身村民」权限（管理员本来就有，见 `may_possess`）
    #[serde(default)]
    pub p: bool,
    /// 管理服务自己用的服务票：内部问世界、请村民入住，等同于管理员
    #[serde(default)]
    pub s: bool,
    /// 只在这一个镇里有效
    #[serde(default)]
    pub t: String,
    /// 到期时刻（unix 秒）
    #[serde(default)]
    pub e: u64,
}

impl Ticket {
    /// 管理服务自己用的票：内部查询、请村民入住、撤村民、送每日额度。
    pub fn service(town: &str, expires: u64) -> Self {
        Self {
            u: String::new(),
            a: true,
            p: true,
            s: true,
            t: town.to_owned(),
            e: expires,
        }
    }

    /// 签给某个登录账号的票。`admin` 是这个账号在小镇里的角色，`possess` 是管理员放开的附身权限。
    pub fn user(id: &str, admin: bool, possess: bool, town: &str, expires: u64) -> Self {
        Self {
            u: id.to_owned(),
            a: admin,
            p: possess,
            s: false,
            t: town.to_owned(),
            e: expires,
        }
    }

    /// 能改世界设置、请村民入住：管理员和服务票都算。
    pub fn admin(&self) -> bool {
        self.s || self.a
    }

    /// 能附身村民：管理员本来就可以，普通账号要管理员在账号页放开。
    pub fn may_possess(&self) -> bool {
        self.admin() || self.p
    }
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        let mut digest = Sha256::new();
        digest.update(key);
        let long = digest.finalize();
        block[..32].copy_from_slice(&long);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let digits = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in digits.chunks(2) {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        out.push((high * 16 + low) as u8);
    }
    Some(out)
}

/// 签一张票。`secret` 就是世界的口令。
pub fn sign(secret: &str, ticket: &Ticket) -> String {
    let body = serde_json::to_string(ticket).unwrap_or_else(|_| "{}".into());
    let payload = to_hex(body.as_bytes());
    let signature = to_hex(&hmac_sha256(secret.as_bytes(), payload.as_bytes()));
    format!("v1.{payload}.{signature}")
}

/// 验一张票。`town` 是世界自己的镇号：票上写的是别的镇就不认。
pub fn verify(secret: &str, town: Option<&str>, raw: &str, now: u64) -> Result<Ticket, String> {
    if raw.len() > MAX_TICKET {
        return Err("入场票太长".into());
    }
    let mut parts = raw.split('.');
    let (Some("v1"), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("入场票格式不对，请从小镇列表重新进入".into());
    };
    let left = from_hex(signature).ok_or("入场票格式不对，请从小镇列表重新进入")?;
    let right = hmac_sha256(secret.as_bytes(), payload.as_bytes());
    if left != right {
        return Err("入场票对不上，请从小镇列表重新进入".into());
    }
    let body = from_hex(payload).ok_or("入场票格式不对，请从小镇列表重新进入")?;
    let ticket: Ticket =
        serde_json::from_slice(&body).map_err(|_| "入场票读不出来，请从小镇列表重新进入")?;
    if ticket.e <= now {
        return Err("入场票过期了，请刷新页面重新进入".into());
    }
    if let Some(town) = town {
        if ticket.t != town {
            return Err("这张票不是这个镇的，请从小镇列表重新进入".into());
        }
    }
    Ok(ticket)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 先对准标准：RFC 4231 第 2 组
    #[test]
    fn the_signature_matches_the_standard_example() {
        let digest = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            to_hex(&digest),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// 一张票只在一个镇、一段时间里有效；改一个字节就不认
    #[test]
    fn a_ticket_only_counts_in_its_own_town_and_time() {
        let secret = "世界口令";
        let ticket = Ticket::user("u1", false, false, "town-a", 1_000);
        let raw = sign(secret, &ticket);
        let now = 999;
        assert_eq!(verify(secret, Some("town-a"), &raw, now).unwrap(), ticket);
        assert_eq!(
            verify(secret, Some("town-a"), &raw, now).unwrap().admin(),
            false
        );
        assert!(verify(secret, Some("town-b"), &raw, now)
            .unwrap_err()
            .contains("不是这个镇"));
        assert!(verify(secret, Some("town-a"), &raw, 1_000)
            .unwrap_err()
            .contains("过期"));
        assert!(verify("别的口令", Some("town-a"), &raw, now)
            .unwrap_err()
            .contains("对不上"));
        let mut broken = raw.clone();
        let swap = if &broken[3..4] == "0" { "1" } else { "0" };
        broken.replace_range(3..4, swap);
        assert!(verify(secret, Some("town-a"), &broken, now).is_err());
        assert!(verify(secret, Some("town-a"), "乱七八糟", now).is_err());
    }

    /// 管理员的票能改世界，普通账号的票不能；服务票等同于管理员
    #[test]
    fn only_an_admin_ticket_may_change_the_world() {
        assert!(Ticket::user("u1", true, false, "t", 9).admin());
        assert!(!Ticket::user("u2", false, false, "t", 9).admin());
        assert!(Ticket::service("t", 9).admin());
        assert!(Ticket::service("t", 9).s);
    }

    /// 附身：管理员本来就有，普通账号要票上带 p；旧票（没有 p 字段）读成 false
    #[test]
    fn only_a_permitted_ticket_may_possess() {
        assert!(Ticket::user("u1", true, false, "t", 9).may_possess());
        assert!(!Ticket::user("u2", false, false, "t", 9).may_possess());
        assert!(Ticket::user("u3", false, true, "t", 9).may_possess());
        assert!(Ticket::service("t", 9).may_possess());
        let legacy: Ticket =
            serde_json::from_str(r#"{"u":"u4","a":false,"s":false,"t":"t","e":9}"#)
                .expect("旧票读不出来");
        assert!(!legacy.may_possess());
    }
}
