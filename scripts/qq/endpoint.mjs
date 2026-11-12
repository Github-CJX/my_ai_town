//! 桥连世界用的地址：端口与口令每次现算（世界重启就变），入场票由管理进程现签。
//!
//! 单拎出来是有原因的：签票密钥只在管理进程内存里（`scripts/towns/hosts.mjs` 的
//! `worldSecret`），所以这段既不能搬进桥自己的进程，也不该内联在 `town-manager.mjs`
//! 的闭包里——那样一行都测不到。世界没在跑（或已经死了）时返回 null，桥会隔一会儿再问。

import { withTicket } from '../towns/ticket.mjs'

/** 给一组世界（`Hosts`）造一个「镇 + 账号 → 世界地址」的函数。 */
export function createWorldEndpoint(hosts) {
  return (town, account) => {
    const port = hosts.worldPort(town)
    const secret = hosts.worldSecret(town)
    if (!port || !secret) return null
    const ticket = hosts.ticket(town, account, false, false)
    if (!ticket) return null
    return withTicket(`ws://127.0.0.1:${port}/?session=${secret}`, ticket)
  }
}
