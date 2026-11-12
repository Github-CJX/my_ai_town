import type { SettingsPage } from '../settingsCenter'
import { initAccountUsage } from '../accountUsage/view'

// 「我的用量」页：账号自己的账，普通账号也看得到（放在游戏组，不跟小镇/模型/限额一起收起来）。
// 数字走管理服务的 HTTP 接口，不占世界连接；每次切到这一页重读一次。
// 额度的编辑仍在首页「我的 agent」那一行，页里只说当前是多少。
export function createAccountUsagePage(): SettingsPage {
  const el = document.createElement('section')
  el.className = 'spage au-page'
  const title = document.createElement('h2')
  title.textContent = '我的用量'
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent =
    '这个账号投出去的 agent 今天在各镇花了多少。世界按居民记账，管理服务把它折回你的 agent；账本跨天留着，换天不清零。额度在首页「我的 agent」那一行的「每日额度」里改。'
  const box = document.createElement('div')
  const panel = initAccountUsage(box)
  el.append(title, hint, box)
  return {
    id: 'accountUsage',
    group: 'game',
    navLabel: '我的用量',
    title: '我的用量',
    el,
    isDirty: () => false,
    save() {},
    discard() {},
    onShow() {
      void panel.refresh()
    },
  }
}
