//! QQ 官方机器人网关（API v2）的最小客户端：取票、连网关、心跳、重连、Resume。
//!
//! 只用 Node 自带的 fetch 与 WebSocket（Node 22+ 全局可用），不引第三方依赖。
//! 这里只做「通道」：把网关上的事件原样交给上层，不解释业务，也不碰世界。
//!
//! 官方文档：
//!   https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
//!   https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/guide.html

import { readFile } from 'node:fs/promises'

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const GATEWAY_URL = 'https://api.sgroup.qq.com/gateway/bot'

/** 私聊（C2C）与群聊事件都在这个位。 */
export const INTENT_GROUP_AND_C2C = 1 << 25

/** 心跳 ACK 收不到时的容忍次数，超过就重连。 */
const MAX_MISSED_ACK = 2

export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

/** 读配置文件（服务器上是 `config/qq.json`，600 权限）。缺字段要大声说，不要拿空串去换票。 */
export async function readCredentials(path) {
  const raw = await readFile(path, 'utf8')
  const data = JSON.parse(raw)
  const appId = String(data.app_id ?? '').trim()
  const appSecret = String(data.app_secret ?? '').trim()
  if (!appId || !appSecret) throw new Error(`${path} 里缺 app_id 或 app_secret`)
  return { appId, appSecret }
}

/** 换票。有效期由服务端给（expires_in 秒），提前一分钟就算过期，避免卡在边界上。 */
export async function fetchToken({ appId, appSecret }, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`换票失败 HTTP ${response.status}：${text.slice(0, 200)}`)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`换票返回的不是 JSON：${text.slice(0, 200)}`)
  }
  const token = String(data.access_token ?? '').trim()
  if (!token) throw new Error(`换票返回里没有 access_token：${text.slice(0, 200)}`)
  const ttl = Number(data.expires_in ?? 7200)
  return { token, expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000 }
}

/** 拿网关地址（每次重连都要重新问，地址会变）。 */
export async function fetchGateway(token, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(GATEWAY_URL, {
    headers: { authorization: `QQBot ${token}` },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`取网关地址失败 HTTP ${response.status}：${text.slice(0, 200)}`)
  const data = JSON.parse(text)
  const url = String(data.url ?? '').trim()
  if (!url) throw new Error(`取网关地址返回里没有 url：${text.slice(0, 200)}`)
  return url
}

/** 日志里只留 openid 尾号，别把整串写进文件。 */
export function maskId(id) {
  const text = String(id ?? '')
  return text.length <= 6 ? '***' : `***${text.slice(-6)}`
}

/**
 * 一条连接。上层只关心 `onEvent(event)`，重连、心跳、Resume 都在里面。
 *
 * 返回 `{ start, stop }`；`start()` 一直挂着直到 `stop()` 或重试次数用尽。
 */
export function createGateway({
  token,
  intents = INTENT_GROUP_AND_C2C,
  onEvent = () => {},
  onLog = () => {},
  onReady = () => {},
  WebSocketImpl = globalThis.WebSocket,
  maxAttempts = 5,
  sleep = defaultSleep,
} = {}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('这个 Node 没有 WebSocket')
  if (!token) throw new Error('没有 access_token')

  let socket = null
  let heartbeat = null
  let missed = 0
  let sequence = null
  let sessionId = null
  let stopped = false
  let attempt = 0

  const clearHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  const close = () => {
    clearHeartbeat()
    if (socket) {
      try {
        socket.close()
      } catch {
        // 已经断了就算了
      }
      socket = null
    }
  }

  const send = (payload) => {
    if (!socket) return
    socket.send(JSON.stringify(payload))
  }

  const startHeartbeat = (interval) => {
    clearHeartbeat()
    missed = 0
    heartbeat = setInterval(
      () => {
        if (missed > MAX_MISSED_ACK) {
          onLog('心跳没回应，重连')
          close()
          void connect()
          return
        }
        missed += 1
        send({ op: OP.HEARTBEAT, d: sequence })
      },
      Math.max(1000, Number(interval) || 41250)
    )
    // 不要拖住宿主进程退出
    heartbeat.unref?.()
  }

  const identify = () =>
    send({ op: OP.IDENTIFY, d: { token: `QQBot ${token}`, intents, shard: [0, 1] } })

  const resume = () =>
    send({ op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: sessionId, seq: sequence } })

  function handle(payload) {
    const op = payload?.op
    if (payload?.s !== undefined && payload?.s !== null) sequence = payload.s
    if (op === OP.HELLO) {
      const interval = payload?.d?.heartbeat_interval
      startHeartbeat(interval)
      if (sessionId) resume()
      else identify()
      return
    }
    if (op === OP.DISPATCH) {
      const name = payload?.t ?? ''
      if (name === 'READY') {
        sessionId = payload?.d?.session_id ?? null
        attempt = 0
        onReady(payload?.d ?? {})
        onLog(`就绪：${payload?.d?.user?.username ?? '(无名)'}`)
        return
      }
      onEvent({ name, data: payload?.d ?? {}, id: payload?.id ?? null })
      return
    }
    if (op === OP.HEARTBEAT_ACK) {
      missed = 0
      return
    }
    if (op === OP.RECONNECT) {
      onLog('服务端要求重连')
      close()
      void connect()
      return
    }
    if (op === OP.INVALID_SESSION) {
      onLog('会话失效，重新 identify')
      sessionId = null
      sequence = null
      identify()
    }
  }

  async function connect() {
    if (stopped) return
    attempt += 1
    try {
      const url = await fetchGateway(token, {})
      if (stopped) return
      onLog(`连网关（第 ${attempt} 次）`)
      socket = new WebSocketImpl(url)
      socket.addEventListener('message', (event) => {
        let payload
        try {
          payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
        } catch {
          onLog('收到一条看不懂的消息，跳过')
          return
        }
        handle(payload)
      })
      socket.addEventListener('error', () => onLog('网关连接出错'))
      socket.addEventListener('close', () => {
        clearHeartbeat()
        socket = null
        if (stopped) return
        if (attempt >= maxAttempts) {
          onLog(`连续 ${attempt} 次没连上，放弃`)
          return
        }
        const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1))
        onLog(`${Math.round(wait / 1000)} 秒后重试`)
        void sleep(wait).then(connect)
      })
    } catch (error) {
      onLog(`连网关失败：${error instanceof Error ? error.message : String(error)}`)
      if (attempt >= maxAttempts) return
      const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1))
      await sleep(wait)
      if (!stopped) await connect()
    }
  }

  return {
    start: connect,
    stop() {
      stopped = true
      close()
    },
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
