// 地图页 ⇄ 设定中心：进入时记录速度并暂停，返回时恢复镜头与进入前的速度（进入前暂停就保持暂停）。
import { $ } from '../dom'
import type { GameMap } from '../gameMap'
import type { ClientMsg } from '../protocol'
import type { ShellPanel } from './panel'
import { newId } from '../ids'

interface SettingsCenter {
  showPage(id: string): void
  enter(id?: string): void
  isDirty(): boolean
  discardAll(): void
}

export function createSettingsSession(
  map: GameMap,
  send: (msg: ClientMsg) => void,
  game: boolean,
  /** 进设定前交还化身控制；交还失败就留在地图上 */
  releaseAvatar: () => Promise<boolean>,
  /** 账号档案：只有管理员有调速度的权限，普通账号进设定不暂停世界（也没权暂停） */
  account: { ready: () => Promise<void>; admin: () => boolean }
) {
  let inSettings = false
  let speedBefore: number | null = null
  let savedViewBox: number[] | null = null
  let currentSpeed: number | null = null
  let center: SettingsCenter | null = null
  /** 顶栏写明返回地图后世界怎样继续（普通账号不管速度，不写这一行） */
  function showResume() {
    const admin = account.admin()
    $('settings-resume').textContent = !admin
      ? ''
      : speedBefore
        ? '返回地图后继续运行'
        : '返回地图后保持暂停'
  }
  /** 世界重置或设定改变后不再恢复进入前的速度 */
  function forgetSpeed() {
    speedBefore = null
    showResume()
  }
  const panel: ShellPanel = {
    roster({ msg }) {
      currentSpeed = msg.speed
    },
    // 在设定中心里重置：返回地图时不再恢复进入前的速度，新世界保持暂停
    onReset: forgetSpeed,
  }
  return {
    panel,
    bind(c: SettingsCenter) {
      center = c
    },
    inSettings: () => inSettings,
    setSpeed(speed: number) {
      currentSpeed = speed
    },
    forgetSpeed,
    async enter(pageId?: string) {
      if (!center) return
      if (inSettings) {
        if (pageId) center.showPage(pageId)
        return
      }
      if (!(await releaseAvatar())) return
      // 档案没问回来之前不知道是不是管理员：先等它，免得管理员头一次进来只看到普通账号那一套
      await account.ready()
      inSettings = true
      speedBefore = account.admin() ? currentSpeed : null
      showResume()
      if (account.admin()) send({ type: 'set_speed', request_id: newId(), speed: 0 })
      savedViewBox = map.getViewBox()
      // 游戏界面：设定中心是地图上的居中小窗，地图留在背后（inert 防止误操作）
      $('obs-view').hidden = !game
      if (game) $('obs-view').inert = true
      $('settings-view').hidden = false
      center.enter(pageId)
    },
    exit() {
      if (!center) return
      if (center.isDirty()) {
        // 不静默丢弃：确定 = 放弃修改返回，取消 = 继续编辑
        if (!confirm('设定里有未保存的修改。\n「确定」放弃修改并返回地图；「取消」继续编辑。'))
          return
        center.discardAll()
      }
      inSettings = false
      $('settings-view').hidden = true
      $('obs-view').hidden = false
      $('obs-view').inert = false
      if (savedViewBox) map.setViewBox(savedViewBox)
      // 普通账号没暂停过世界，也就没有速度要还
      if (speedBefore && account.admin())
        send({ type: 'set_speed', request_id: newId(), speed: speedBefore })
      speedBefore = null
    },
  }
}
export type SettingsSession = ReturnType<typeof createSettingsSession>
