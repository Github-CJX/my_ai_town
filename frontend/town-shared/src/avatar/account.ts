// 这台电脑上的账号（管理服务的 /api/towns/users）：当前是谁、是不是管理员、
// 这个账号在小镇里固定的那个化身。管理服务没有账号接口（老版本）时一律按「本机单人」
// 处理：管理员、不绑定，和以前的单人玩法一样；有账号接口但还没选号时，谁也不是管理员。
import { bindAvatar, readAccounts, type HomeAccount } from '../townApi'
import type { RememberedAvatar } from './identity'

export function createAvatarAccount() {
  let who: HomeAccount | null = null
  /** 老版本管理服务没有账号接口：按本机单人玩 */
  let legacy = false
  let asked = false

  return {
    /** 问一次管理服务：这个页面用哪个档案。慢一点也没关系，问回来之前当「还没有账号」 */
    load() {
      if (asked) return
      asked = true
      void readAccounts().then((list) => {
        legacy = list === null
        who = list?.current ?? null
      })
    },

    /** 能不能附身村民：管理员可以（开镇、调世界用），普通账号只能玩自己的化身 */
    admin: () => legacy || who?.role === 'admin',

    /** 这个账号的名字：第一次进镇时化身名字的默认值 */
    name: () => who?.name ?? '',

    /** 这个账号认下的化身：进镇、回到上次的位置都用它。颜色不知道时沿用本页记着的 */
    self(color?: string): RememberedAvatar | null {
      if (!who?.avatar_id) return null
      return {
        id: who.avatar_id,
        name: who.avatar_name || who.name,
        color: color ?? '#ffffff',
      }
    },

    /** 控制住自己的化身之后记回账号：第一次认下、改名之后各记一次（编号不变就不重复发） */
    bind(actor: { id: string; name: string }) {
      if (who) {
        if (who.avatar_id === actor.id && who.avatar_name === actor.name) return
        who.avatar_id = actor.id
        who.avatar_name = actor.name
      }
      void bindAvatar(actor.id, actor.name)
    },
  }
}
