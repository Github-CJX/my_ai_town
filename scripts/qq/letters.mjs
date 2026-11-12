//! QQ 私聊与镇里「传讯」之间的那一层：只做文字上的搬运，不碰世界也不碰网络。
//!
//! 官方规矩（被动回复）：收到一条私聊后 60 分钟内可以回，同一条消息最多回 4 次，
//! 每次 `msg_seq` 递增且不能重复。超过窗口就得走主动消息（要用户端先允许主动发送），
//! 这里不擅自发——宁可少一句，也不要因为一条被拒的消息把连接搞坏。

/** 一封信最长多少字：和内核的 `MESSAGE_MAX_CHARS` 同一把尺子。 */
export const MAX_LETTER_CHARS = 400

/** 被动回复窗口：60 分钟。 */
export const PASSIVE_MS = 60 * 60 * 1000

/** 同一条私聊最多回几次。 */
export const MAX_REPLIES = 4

/** QQ 说的「@某人」前缀在私聊里不会出现，群聊转过来时先剥掉，别把它当正文。 */
const MENTION = /^(?:<@!?[^>]+>\s*)+/

/**
 * 一条 QQ 私聊的正文 → 信的内容。
 *
 * 空话直接返回空串（上层据此回一句提示，不发空信：内核会拒）。超长按字数截断：
 * 宁可少半句，也不要整封退回去让她什么都收不到。
 */
export function letterContent(raw, limit = MAX_LETTER_CHARS) {
  const text = String(raw ?? '')
    .replace(MENTION, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const chars = [...text]
  if (chars.length <= limit) return text
  return chars.slice(0, limit).join('')
}

/** 收到的一封信 → 发给主人的一句私聊。 */
export function letterNotice({ name, text }) {
  const who = String(name ?? '').trim() || '镇里有人'
  return `「${who}」传讯给你：${String(text ?? '').trim()}`
}

/**
 * 被动回复的记账：记下最近一条收到的私聊，回的时候取 `{msgId, msgSeq}`。
 *
 * 世界那侧是异步的（她可能过一会儿才回信），所以回信时不能想当然认为窗口还开着。
 */
export function createReplyTrack({ now = Date.now } = {}) {
  let current = null
  const track = {
    /** 收到一条私聊；同一条重复投递不算新消息（网关会重发）。 */
    note(msgId, at = now()) {
      const id = String(msgId ?? '')
      if (!id) return
      if (current && current.msgId === id) return
      current = { msgId: id, at: Number(at) || now(), seq: 0 }
    },
    /** 还能不能被动回：返回这次要带的 `{msgId, msgSeq}`，不能就是 null。 */
    next(at = now()) {
      if (!current) return null
      if (at - current.at > PASSIVE_MS) return null
      if (current.seq >= MAX_REPLIES) return null
      current.seq += 1
      return { msgId: current.msgId, msgSeq: current.seq, at: current.at }
    },
    /** 还剩几次被动回复。 */
    left(at = now()) {
      if (!current || at - current.at > PASSIVE_MS) return 0
      return Math.max(0, MAX_REPLIES - current.seq)
    },
    get last() {
      return current ? { ...current } : null
    },
  }
  return track
}
