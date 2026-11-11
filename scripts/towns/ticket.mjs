// 入场票：管理服务用世界的口令签一张票，世界凭票认人（对应 crates/host/src/ticket.rs）。
// 票面是 JSON 的十六进制，签名是 HMAC-SHA256，格式 `v1.<hex 票面>.<hex 签名>`。
// 世界口令只写在 host 进程参数里，页面拿不到；票放在页面拿到的连接地址里，24 小时后过期。
import { createHmac } from 'node:crypto'

/** 票的有效期（秒）：够玩一晚上，又不会一直留在浏览器历史里。 */
export const TTL = 24 * 3600

/** 世界自己用的票：管理服务问状态、请村民入住时带它，等同于管理员。 */
export function serviceTicket(town, expires) {
  return { u: '', a: false, s: true, t: town, e: expires }
}

/** 一个登录账号的票：`admin` 是他在这个小镇里的角色。 */
export function userTicket(id, admin, town, expires) {
  return { u: id, a: Boolean(admin), s: false, t: town, e: expires }
}

export function signTicket(secret, ticket) {
  const payload = Buffer.from(JSON.stringify(ticket), 'utf8').toString('hex')
  const signature = createHmac('sha256', secret).update(payload).digest('hex')
  return `v1.${payload}.${signature}`
}

/** 在连接地址上换一张票：旧票去掉，新票接上。 */
export function withTicket(endpoint, ticket) {
  const url = new URL(endpoint)
  url.searchParams.delete('ticket')
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

/** 现在（unix 秒）：签票时要写上到期时刻。 */
export function nowSecs() {
  return Math.floor(Date.now() / 1000)
}

/** 票的到期时刻：按整点算，保证比现在晚一天以上；同一小时内反复进镇拿到的是同一张票。 */
export function ticketExpiry(now = nowSecs()) {
  return (Math.floor(now / 3600) + 1) * 3600 + TTL
}
