//! 桥连世界的那一头：一位账号一条长连接，按 request_id 收发，掉线自己重连。
//!
//! QQ 桥不能自己签票（签票密钥只在管理进程里），所以地址由上层每次现算：世界重启过后
//! 端口和口令都会变，`endpoint()` 每次重连都重新问一遍，别缓存。
//!
//! 这里只做「把 ClientMsg 发出去、等对应的 ServerMsg」，不解释业务。

import { randomUUID } from 'node:crypto'
import { WebSocket } from '../towns/socket.mjs'

/** 一条请求等多久。世界每拍都在跑，10 秒还没回就是真出事了。 */
const REQUEST_TIMEOUT_MS = 10_000
/** 连不上就隔一会儿再试：世界可能正在重启。 */
const RETRY_MS = 5_000
/** 世界说「世界已重置」时，缓存的 world_id 就得作废。 */
const RESET_HINT = '世界已重置'

export function createWorldLink({
  endpoint,
  log = () => {},
  WebSocketImpl = WebSocket,
  retryMs = RETRY_MS,
}) {
  let socket = null
  let ready = false
  let stopped = false
  let worldId = null
  let retry = null
  const pending = new Map()
  const waiters = new Set()

  const settle = (requestId, error, message) => {
    const entry = pending.get(requestId)
    if (!entry) return false
    pending.delete(requestId)
    clearTimeout(entry.timer)
    error ? entry.reject(error) : entry.resolve(message)
    return true
  }

  const wake = (message) => {
    for (const waiter of [...waiters]) {
      if (waiter.type !== message.type) continue
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
  }

  function handle(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      log('世界返回了一条看不懂的消息，跳过')
      return
    }
    if (message?.type === 'error' && String(message.message ?? '').includes(RESET_HINT))
      worldId = null
    if (message?.request_id && settle(message.request_id, null, message)) return
    if (message?.type) wake(message)
  }

  function schedule() {
    if (stopped || retry) return
    retry = setTimeout(() => {
      retry = null
      void connect()
    }, retryMs)
    retry.unref?.()
  }

  async function connect() {
    if (stopped || socket) return
    let url
    try {
      url = await endpoint()
    } catch (error) {
      log(`问不到世界地址：${text(error)}`)
      schedule()
      return
    }
    if (!url) {
      schedule()
      return
    }
    if (stopped) return
    let link
    try {
      link = new WebSocketImpl(url)
    } catch (error) {
      log(`连世界失败：${text(error)}`)
      schedule()
      return
    }
    socket = link
    link.onopen = () => {
      ready = true
      log('连上世界')
    }
    link.onmessage = (event) => handle(event.data)
    link.onerror = () => {}
    link.onclose = () => {
      if (socket === link) socket = null
      if (ready) log('世界连接断了')
      ready = false
      for (const id of [...pending.keys()]) settle(id, Error('世界连接断了'))
      for (const waiter of [...waiters]) {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.reject(Error('世界连接断了'))
      }
      schedule()
    }
  }

  function send(message) {
    if (!ready || !socket) throw new Error('世界还没连上')
    socket.send(JSON.stringify(message))
  }

  /** 等一条没有 request_id 的回执（世界设置就是这种）。 */
  function waitFor(type, timeout = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject }
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter)
        reject(Error(`世界没有及时回 ${type}`))
      }, timeout)
      waiter.timer.unref?.()
      waiters.add(waiter)
    })
  }

  /** 发一条带 request_id 的命令，等它自己那条回执；`error` 回执当失败。 */
  function request(message, expect, timeout = REQUEST_TIMEOUT_MS) {
    if (!ready) return Promise.reject(new Error('世界还没连上'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject }
      entry.timer = setTimeout(() => {
        pending.delete(requestId)
        reject(Error(`世界没有及时回 ${expect}`))
      }, timeout)
      entry.timer.unref?.()
      pending.set(requestId, entry)
      try {
        send({ ...message, request_id: requestId })
      } catch (error) {
        settle(requestId, error instanceof Error ? error : Error(String(error)))
      }
    }).then((reply) => {
      if (!expect.includes(reply.type)) throw Error(reply.message || `世界回了 ${reply.type}`)
      return reply
    })
  }

  /** 世界的编号：带 world_id 的命令都要它，每次世界重置会换。 */
  async function currentWorldId() {
    if (worldId) return worldId
    const waiting = waitFor('world_settings')
    send({ type: 'get_world_settings' })
    const message = await waiting
    worldId = String(message.state?.world_id ?? '')
    if (!worldId) throw Error('世界的设置里没有编号')
    return worldId
  }

  /** 以这个账号的身份给她传讯。收信人按名字或编号都行。 */
  async function sendLetter({ to, text }) {
    const message = await request(
      { type: 'send_letter', world_id: await currentWorldId(), to, text },
      ['letter_sent']
    )
    return message
  }

  /** 我这边新到的信：`incoming === true` 的才是别人写给我的。 */
  async function letters({ after = 0 } = {}) {
    const message = await request(
      { type: 'get_letters', world_id: await currentWorldId(), after: Math.max(0, after | 0) },
      ['letters']
    )
    return { letters: message.letters ?? [], cursor: Number(message.cursor) || 0 }
  }

  return {
    connect,
    get connected() {
      return ready
    },
    worldId: currentWorldId,
    sendLetter,
    letters,
    stop() {
      stopped = true
      if (retry) clearTimeout(retry)
      retry = null
      const link = socket
      socket = null
      ready = false
      try {
        link?.close()
      } catch {
        // 已经断了就算了
      }
    },
  }
}

function text(error) {
  return error instanceof Error ? error.message : String(error)
}
