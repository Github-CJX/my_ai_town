// 台词里夹着的动作与神情：「（脸颊微红，轻轻挣了一下）讨厌，大庭广众的」。
// 括起来的是给人看的旁白，不改变世界里的任何事实——世界只认 say.message 这行字本身。
// 这里只管切分与呈现；写什么、什么时候写，是模型与提示词的事。
const ACT = /[（(]([^（()）\n]{1,80})[)）]/g

/** 一段台词：`act` 为真表示这段是括起来的旁白。 */
export type SpeechPart = { text: string; act: boolean }

/** 把一句台词切成「说的」和「做的」：括起来的算旁白，空白段（连同旁边的空档）不留下。 */
export function speechParts(text: string): SpeechPart[] {
  const parts: SpeechPart[] = []
  let at = 0
  for (const match of text.matchAll(ACT)) {
    const start = match.index ?? 0
    if (start > at) parts.push({ text: text.slice(at, start), act: false })
    parts.push({ text: match[1], act: true })
    at = start + match[0].length
  }
  if (at < text.length) parts.push({ text: text.slice(at), act: false })
  return parts.filter((part) => part.text.trim() !== '')
}

/** 画进一个元素：旁白加 `say-act` 样式，台词照常。整句都是空白时原样放进文字。 */
export function fillSpeech(target: HTMLElement, text: string): void {
  const parts = speechParts(text)
  if (!parts.length) {
    target.textContent = text
    return
  }
  target.replaceChildren(
    ...parts.map((part) => {
      if (!part.act) return document.createTextNode(part.text)
      const act = document.createElement('span')
      act.className = 'say-act'
      act.textContent = part.text
      return act
    })
  )
}
