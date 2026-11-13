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
/** 重连间隔的上限：QQ 那边限流时只是一阵子，等下去了自然会好，别退到几小时。 */
const MAX_WAIT_MS = 60_000
/** 「接口调用超过频率限制」(100017) 这类错要慢慢来：一分钟一次，够快也不会再撞上去。 */
const RATE_LIMIT = /100017|频率限制|too many requests?|rate limit/i

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

/**
 * 给一个 QQ 号发私聊。
 *
 * 被动回复必须带 `msg_id`（回的是收到的哪一条）与递增的 `msg_seq`（同一条最多 4 次）；
 * 不带 `msg_id` 就是主动消息，那要对方先在 QQ 里允许主动发送。
 */
export async function sendC2C({
  token,
  openid,
  content,
  msgId = '',
  msgSeq = 1,
  fetchImpl = fetch,
} = {}) {
  const who = String(openid ?? '').trim()
  if (!who) throw new Error('没有收信人的 openid')
  const body = { content: String(content ?? ''), msg_type: 0 }
  if (msgId) {
    body.msg_id = String(msgId)
    body.msg_seq = Math.max(1, Number(msgSeq) || 1)
  }
  const url = `https://api.sgroup.qq.com/v2/users/${encodeURIComponent(who)}/messages`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`发私聊失败 HTTP ${response.status}：${text.slice(0, 200)}`)
  try {
    const data = JSON.parse(text)
    return { id: String(data.id ?? ''), timestamp: String(data.timestamp ?? '') }
  } catch {
    return { id: '', timestamp: '' }
  }
}

/** 日志里只留 openid 尾号，别把整串写进文件。 */
export function maskId(id) {
  const text = String(id ?? '')
  return text.length <= 6 ? '***' : `***${text.slice(-6)}`
}

/**
 * 一条连接。上层只关心 `onEvent(event)`，重连、心跳、Resume 都在里面。
 *
 * 返回 `{ start, stop }`；`start()` 一直挂着直到 `stop()`（或者调用方自己把 `maxAttempts` 限死）。
 */
export function createGateway({
  token,
  // 长跑时票会过期（两小时）：给了 `getToken` 就每次重连现问一张，不给就沿用 `token`。
  getToken = null,
  intents = INTENT_GROUP_AND_C2C,
  onEvent = () => {},
  onLog = () => {},
  onReady = () => {},
  WebSocketImpl = globalThis.WebSocket,
  maxAttempts = Infinity,
  sleep = defaultSleep,
} = {}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('这个 Node 没有 WebSocket')
  if (!getToken && !token) throw new Error('没有 access_token')

  let current = token ?? ''
  const freshToken = async () => {
    if (!getToken) return current
    const next = String((await getToken()) ?? '').trim()
    if (!next) throw new Error('换票换回来一张空票')
    current = next
    return next
  }

  let socket = null
  let heartbeat = null
  let missed = 0
  let sequence = null
  let sessionId = null
  let stopped = false
  let attempt = 0
  let lastError = ''

  /** 第 n 次失败后等多久：限流就固定一分钟，别的按 1、2、4…秒退避，最多一分钟。 */
  const waitFor = (n, message) => {
    if (RATE_LIMIT.test(message)) return MAX_WAIT_MS
    return Math.min(MAX_WAIT_MS, 1000 * 2 ** Math.min(n - 1, 6))
  }

  const clearHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  /**
   * 一次失败之后的重试。断线、取地址被限流、换票失败都走这里。
   *
   * 不永久放弃：QQ 那边限流只是一阵子（我们连续重启几次就会撞上），凭证配错了也能在
   * 管理服务里改完就接上，不该逼人再重启一次进程。代价是日志：同一句错只记一次，
   * 之后每十次记一次，免得把真事故淹掉。
   */
  const retry = (message) => {
    if (stopped) return
    const wait = waitFor(attempt, message)
    if (message !== lastError || attempt % 10 === 0) {
      lastError = message
      onLog(`连网关失败：${message}；${Math.round(wait / 1000)} 秒后再试（第 ${attempt} 次）`)
    }
    if (attempt >= maxAttempts) {
      onLog(`连续 ${attempt} 次没连上，放弃`)
      return
    }
    void sleep(wait).then(connect)
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
    send({ op: OP.IDENTIFY, d: { token: `QQBot ${current}`, intents, shard: [0, 1] } })

  const resume = () =>
    send({ op: OP.RESUME, d: { token: `QQBot ${current}`, session_id: sessionId, seq: sequence } })

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
        lastError = ''
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
      await freshToken()
      const url = await fetchGateway(current, {})
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
        retry('连接断了')
      })
    } catch (error) {
      retry(error instanceof Error ? error.message : String(error))
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
