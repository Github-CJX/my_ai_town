// 玩家主动提的三种亲近：牵一下手、靠一会儿、抱一下。
// 世界那边一直收这种邀请（内核的 offer 里专门给玩家和村民留了处所），只是页面从前没发过，
// 所以「牵手/依偎/拥抱」只有 agent 能提。这里只放说法与命令的拼装，不碰 DOM，单独测得到。
export type Gesture = 'hold_hands' | 'lean' | 'hug'

export interface CloseOffer {
  gesture: Gesture
  /** 按钮上的字，短一点：附近的人那一栏还要放「邀请交谈」 */
  label: string
  /** 邀请卡上带的那句话 */
  message: string
}

/** 三种亲近。说法按 gesture 排，界面按这个顺序摆按钮 */
export const TOUCH_OFFERS: readonly CloseOffer[] = [
  { gesture: 'hold_hands', label: '牵一下手', message: '手给我，牵一会儿？' },
  { gesture: 'lean', label: '靠一会儿', message: '让我靠一会儿？' },
  { gesture: 'hug', label: '抱一下', message: '抱一下？' },
]

/** 向某人发出一种亲近邀请。世界会等对方回答：答应就做，躲开了双方和旁人都看得见。 */
export function touchOffer(partner: string, gesture: Gesture) {
  const offer = TOUCH_OFFERS.find((o) => o.gesture === gesture)
  return {
    operation: 'offer' as const,
    partner_id: partner,
    interaction: { kind: 'touch' as const, gesture },
    message: offer?.message ?? '想靠近一点。',
  }
}
