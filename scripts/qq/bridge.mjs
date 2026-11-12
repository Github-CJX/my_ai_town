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

  async function onEvent({ name, data: event }) {
    if (name !== 'C2C_MESSAGE_CREATE') return
    const openid = String(event?.author?.user_openid ?? '').trim()
    const state = states.get(openid)
    if (!state) {
      log(`收到 ${maskId(openid)} 的私聊，但没绑村民，不理`)
      return
    }
    await onMessage(state, event)
  }

  /** 连 QQ 网关。没有绑定就先不连：同一个 bot 上多一条连接会把探针那边的事件抢过来。 */
  function startGateway() {
    if (gateway || !data.bindings.length) return
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
    if (!data.bindings.length) {
      log('还没有绑定：先给一个 QQ 号绑上村民，再来信')
      return
    }
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
      for (const binding of data.bindings) attach(binding)
      startGateway()
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
