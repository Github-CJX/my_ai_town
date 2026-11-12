//! QQ 桥：把主人的私聊递进小镇，把她回的信送回主人的 QQ。
//!
//! 一条绑定 = 一个 QQ 号 + 一个账号 + 一位村民。桥用**绑定账号自己的票**连世界：
//! 世界据此认出「写信人就是这个账号的化身」，越权的绑定会被世界自己挡回去，
//! 桥这边不另做一套权限判断。
//!
//! 两条腿各自异步，谁都不等谁：
//!   QQ → 世界：收到私聊就 `send_letter`，立刻回一句「信递过去了」（或世界给的拒绝原因）；
//!   世界 → QQ：每 2 秒按自己的事件游标拉一次新信，`incoming` 的就是她写的，回给主人。
//!
//! 官方被动回复窗口 60 分钟、同一条最多 4 句，见 `./letters.mjs`。

import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  createGateway,
  fetchToken,
  maskId,
  readCredentials,
  sendC2C,
  INTENT_GROUP_AND_C2C,
} from './gateway.mjs'
import { readBindings, saveBindings, setCursor } from './bindings.mjs'
import { createReplyTrack, letterContent, letterNotice } from './letters.mjs'
import { createWorldLink } from './world.mjs'

/** 多久拉一次新信。世界每拍 100 ms，2 秒足够快，又不至于每个绑定一直占着连接。 */
const POLL_MS = 2000
/** 票还有多久过期就去换新的：桥是长跑，不能等它过期再换。 */
const REFRESH_MS = 5 * 60 * 1000
/** 没绑定的号码来找她，最多留这么多条待认领，也只留这么久（认领要在网页上点）。 */
const CLAIM_MAX = 20
const CLAIM_MS = 30 * 60 * 1000

export function createBridge({
  root,
  // 世界的地址每次现算：世界重启后端口与口令都会变。(town, account) → ws url | null
  endpointFor,
  log = () => {},
  send = sendC2C,
  tokenFactory = fetchToken,
  gatewayFactory = createGateway,
  worldLinkFactory = createWorldLink,
  pollMs = POLL_MS,
  now = () => Date.now(),
} = {}) {
  const configFile = path.join(root, 'config', 'qq.json')
  const bindingsFile = path.join(root, 'config', 'qq-bindings.json')
  const states = new Map()
  /** 还没绑定就来找她的号码：{token → {openid, at, text}}。完整 openid 只留在内存里，
   *  网页那边看到的是尾号；认领时按 token 换回 openid，人不用手打一长串。 */
  const claims = new Map()
  let data = { version: 1, bindings: [] }
  let gateway = null
  let ticket = null
  let appId = ''
  let appSecret = ''
  let started = false
  let stopped = false

  const save = async () => {
    try {
      await saveBindings(bindingsFile, data)
    } catch (error) {
      log(`绑定表没写进去：${text(error)}`)
    }
  }

  /** 一张还没过期的票；快过期了才去换，别每句话都换一次。 */
  async function token() {
    if (ticket && ticket.expiresAt - now() > REFRESH_MS) return ticket.token
    ticket = await tokenFactory({ appId, appSecret })
    return ticket.token
  }

  async function say(state, content) {
    const slot = state.track.next(now())
    if (!slot) {
      log(
        `「${state.binding.resident_name || state.binding.resident}」那边超过被动回复窗口，这句没发`
      )
      return false
    }
    try {
      await send({
        token: await token(),
        openid: state.binding.openid,
        content,
        msgId: slot.msgId,
        msgSeq: slot.msgSeq,
      })
      return true
    } catch (error) {
      log(`回私聊失败：${text(error)}`)
      return false
    }
  }

  /** 世界里她写来的信 → 主人的 QQ。游标逐条推进：发失败的下一轮还会再来一次。 */
  async function poll(state) {
    if (stopped || state.busy || !state.link.connected) return
    state.busy = true
    try {
      const { letters } = await state.link.letters({ after: state.binding.cursor })
      for (const letter of letters) {
        if (!letter.incoming) continue
        const okay = await say(state, letterNotice({ name: letter.from_name, text: letter.text }))
        if (!okay) break
        await moveTo(state, letter.event_id)
      }
    } catch (error) {
      log(`拉信失败：${text(error)}`)
    } finally {
      state.busy = false
    }
  }

  async function moveTo(state, eventId) {
    if (eventId <= state.binding.cursor) return
    state.binding.cursor = eventId
    data = setCursor(data, state.binding.openid, eventId)
    await save()
  }

  function attach(binding) {
    const state = {
      binding,
      track: createReplyTrack({ now }),
      busy: false,
      timer: null,
      link: worldLinkFactory({
        endpoint: async () => endpointFor(binding.town, binding.account),
        log,
      }),
    }
    states.set(binding.openid, state)
    state.link.connect()
    state.timer = setInterval(() => void poll(state), pollMs)
    state.timer.unref?.()
    log(`绑定：${maskId(binding.openid)} ↔ 「${binding.resident_name || binding.resident}」`)
    return state
  }

  /** 一条私聊：先记下能被动回几句，再把话递进镇里。 */
  async function onMessage(state, event) {
    state.track.note(event.id, now())
    const content = letterContent(event.content)
    if (!content) {
      await say(state, '信上什么都没写：说一句话再发过来。')
      return
    }
    if (!state.link.connected) {
      await say(state, '小镇现在没连上（可能没在跑），这封信没递出去。')
      return
    }
    try {
      const sent = await state.link.sendLetter({ to: state.binding.resident, text: content })
      if (!sent.ok) {
        await say(state, `没递到：${sent.message}`)
        return
      }
      log(`递信给「${sent.letter?.to_name ?? state.binding.resident}」：${content.length} 字`)
      // 回一句「到手了」：主人在 QQ 里看不到镇里发生什么，没有回执就分不清是没发出去还是她还没回。
      await say(state, sent.message)
    } catch (error) {
      await say(state, `没递到：${text(error)}`)
    }
  }

  /** 认领用的短号：同一个 openid 每次都一样，重发消息不会多出一行。 */
  function claimToken(openid) {
    return `q${createHash('sha256').update(openid).digest('hex').slice(0, 10)}`
  }

  function prune() {
    const edge = now() - CLAIM_MS
    for (const [token, item] of claims) if (item.at < edge) claims.delete(token)
    while (claims.size > CLAIM_MAX) {
      const oldest = [...claims.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!oldest) break
      claims.delete(oldest[0])
    }
  }

  /** 没绑定的号码来找她：留一行待认领，不递信、不进世界、不花模型钱。 */
  function remember(openid, text) {
    claims.set(claimToken(openid), { openid, at: now(), text: String(text ?? '').slice(0, 40) })
    prune()
  }

  async function onEvent({ name, data: event }) {
    if (name !== 'C2C_MESSAGE_CREATE') return
    const openid = String(event?.author?.user_openid ?? '').trim()
    if (!openid) return
    const state = states.get(openid)
    if (!state) {
      remember(openid, event?.content)
      log(`收到 ${maskId(openid)} 的私聊：还没绑村民，留在网页上等人认领`)
      return
    }
    await onMessage(state, event)
  }

  /** 连 QQ 网关。没有绑定也连：没绑的号码来找她，要在网页上留一行给人认领。 */
  function startGateway() {
    if (gateway) return
    gateway = gatewayFactory({
      getToken: token,
      intents: INTENT_GROUP_AND_C2C,
      onEvent: (event) => void onEvent(event),
      onLog: (message) => log(message),
    })
    void gateway.start()
  }

  async function start() {
    if (started) return
    started = true
    try {
      const credentials = await readCredentials(configFile)
      appId = credentials.appId
      appSecret = credentials.appSecret
      data = await readBindings(bindingsFile)
    } catch (error) {
      log(`桥没起来：${text(error)}`)
      return
    }
    if (!data.bindings.length) log('还没有绑定：谁来找她都先记下，等网页上认领')
    for (const binding of data.bindings) attach(binding)
    startGateway()
  }

  return {
    start,
    status() {
      return {
        ready: Boolean(gateway),
        bindings: [...states.values()].map((state) => ({
          openid: maskId(state.binding.openid),
          account: state.binding.account,
          town: state.binding.town,
          resident: state.binding.resident,
          resident_name: state.binding.resident_name,
          connected: state.link.connected,
          cursor: state.binding.cursor,
        })),
      }
    },
    /** 重新读一遍绑定表：管理端加了绑定之后调它，不用重启进程。 */
    async reload() {
      for (const state of states.values()) {
        clearInterval(state.timer)
        state.link.stop()
      }
      states.clear()
      data = await readBindings(bindingsFile)
      for (const binding of data.bindings) {
        // 认领过的那一行就从待认领里划掉
        claims.delete(claimToken(binding.openid))
        attach(binding)
      }
      startGateway()
    },
    /** 还没绑定就来找她的号码：只给尾号，认领时用 token。 */
    claims() {
      prune()
      return [...claims.entries()]
        .map(([token, item]) => ({ token, masked: maskId(item.openid), at: item.at }))
        .sort((a, b) => b.at - a.at)
    },
    /** 认领：把 token 换回完整 openid（只在内存里，不进日志、不进网页）。 */
    openidOf(token) {
      prune()
      return claims.get(String(token ?? ''))?.openid ?? ''
    },
    /** 绑上了：这一行不用再摆着。 */
    forget(token) {
      claims.delete(String(token ?? ''))
    },
    stop() {
      stopped = true
      for (const state of states.values()) {
        clearInterval(state.timer)
        state.link.stop()
      }
      states.clear()
      gateway?.stop()
      gateway = null
    },
  }
}

function text(error) {
  return error instanceof Error ? error.message : String(error)
}
