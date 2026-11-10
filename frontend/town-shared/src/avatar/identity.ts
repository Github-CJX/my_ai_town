// 这个标签页在这个世界里的化身是谁：退出化身、离开小镇再回来时接着当同一个人。
// 令牌（lease.ts）只管断线续接，退出控制后就作废；身份要单独记着，否则回来会另开一个。
export type RememberedAvatar = { id: string; name: string; color: string }

export function storedAvatar(world: () => string) {
  const key = () => `town-avatar-self:${world()}`
  /** 记着的自己；没记过或读不出来为 null */
  function read(): RememberedAvatar | null {
    try {
      const raw = sessionStorage.getItem(key())
      if (!raw) return null
      const value = JSON.parse(raw) as Partial<RememberedAvatar> | null
      if (!value?.id || !value.name || !value.color) return null
      return { id: value.id, name: value.name, color: value.color }
    } catch {
      return null
    }
  }
  /** 控制中每收到一次化身状态就记一遍：改名、换外观也跟着更新 */
  function remember(actor: { id: string; name: string; appearance: { color: string } }) {
    try {
      sessionStorage.setItem(
        key(),
        JSON.stringify({ id: actor.id, name: actor.name, color: actor.appearance.color })
      )
    } catch {
      // 存不了就下次重新选样子，不影响这次控制
    }
  }
  function forget() {
    try {
      sessionStorage.removeItem(key())
    } catch {
      // 同上
    }
  }
  return { read, remember, forget }
}
