// 化身入口：观察模式底部居中的入口按钮，和进入小镇的对话框。
import type { AvatarCommand } from './types'
import type { LookChoice } from './looks'
import { field, keycap, markerSvg } from './view'
import { isTouch } from '../platform'
import { button, el } from '../dom'

/** 入口和对话框要知道的「我」：还认得的话带编号，再回来就是同一个人 */
export type EntrySelf = { id?: string; name: string; color: string }

function entryPill(continueEntry: () => void) {
  const pill = el('button')
  pill.type = 'button'
  pill.className = 'avatar-enter'
  // 「化身」这个词新手不认识：悬停时说清是什么
  pill.title = '用一个自己的角色进镇走走；走到村民身边就能和他们说话'
  const dot = el('i'),
    text = el('strong'),
    sub = el('small')
  dot.className = 'avatar-dot'
  pill.append(dot, text, sub)
  pill.onclick = () => continueEntry()
  return { pill, dot, text, sub }
}

/** 进入对话框：实时预览、预设色（或外观）、说明出现地点与键位 */
function entryDialog(
  choice: LookChoice,
  closeDialog: () => void,
  execute: (command: AvatarCommand) => Promise<boolean>
) {
  const backdrop = el('div')
  backdrop.className = 'avatar-backdrop'
  backdrop.hidden = true
  const dialog = el('form')
  dialog.className = 'avatar-dialog'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-label', '进入小镇')
  const title = el('h3', '进入小镇')
  const preview = el('div'),
    previewMark = el('span')
  preview.className = 'avatar-preview'
  previewMark.className = 'avatar-preview-mark'
  if (choice.hasLooks) preview.append(el('p', '选一个样子。村民会记住这个名字，改名不换人。'))
  else
    preview.append(previewMark, el('p', '这是你在地图上的样子。村民会记住这个名字，改名不换人。'))
  preview.classList.toggle('avatar-preview-text', choice.hasLooks)
  const name = el('input')
  name.placeholder = '你的名字'
  name.maxLength = 24
  name.value = '旅人'
  name.required = true
  name.setAttribute('aria-label', '化身名字')
  // 还认得自己时带上编号：提交后接着当上次那个化身，回到上次的位置
  let avatarId: string | undefined
  const refreshPreview = () => {
    if (!choice.hasLooks) previewMark.replaceChildren(markerSvg(picker.value, 56))
  }
  const picker = choice.picker(choice.initial, () => refreshPreview())
  refreshPreview()
  const hint = el('p')
  hint.className = 'avatar-hint'
  const enter = el('button', '进入小镇')
  enter.type = 'submit'
  enter.className = 'avatar-primary'
  const cancel = button('取消', () => closeDialog())
  cancel.className = 'avatar-ghost'
  const actions = el('div')
  actions.className = 'avatar-dialog-actions'
  actions.append(cancel, enter)
  const nameField = field('名字', name),
    lookField = field(choice.caption, picker.root)
  const fields = choice.hasLooks ? [lookField, nameField] : [nameField, lookField]
  dialog.append(title, preview, ...fields, hint, actions)
  backdrop.append(dialog)
  dialog.onsubmit = (e) => {
    e.preventDefault()
    const send = (id: string | undefined) =>
      execute(choice.command('enter', name.value, picker.value, id))
    void send(avatarId).then((ok) => {
      if (ok || avatarId === undefined) return
      // 记着的编号已经不归我们（复制了标签页、或另一个页面正握着它）：别再卡着报同样的错
      avatarId = undefined
      void send(undefined)
    })
  }
  return {
    backdrop,
    title,
    name,
    picker,
    refreshPreview,
    hint,
    enter,
    /** 提交时带着这个编号进场：接着当上次那个化身 */
    setAvatar(id: string | undefined) {
      avatarId = id
    },
  }
}

/** 对话框里的说明：从哪里出现、怎样走动和互动。 */
function showHint(hint: HTMLElement, returning: boolean) {
  const where = returning ? '你会回到上次离开的位置。' : '你会从小镇入口出现。'
  // 触屏没有键盘：说摇杆和右下的按钮
  if (isTouch()) {
    hint.replaceChildren(
      where,
      ' 点地图走过去，或者拖左下的摇杆；靠近人或东西时，点右下的按钮和他们互动。'
    )
    return
  }
  hint.replaceChildren(
    where,
    ' 点地图走过去，点人或东西走过去并互动；也可以用 ',
    keycap('W'),
    keycap('A'),
    keycap('S'),
    keycap('D'),
    ' 移动，',
    keycap('E'),
    ' 和身边的东西互动，',
    keycap('B'),
    ' 打开背包。'
  )
}

export function createAvatarEntry(
  choice: LookChoice,
  handlers: {
    openDialog: () => void
    /** 入口按钮：还认得自己就直接回去，认不出才打开对话框 */
    continueEntry: () => void
    closeDialog: () => void
    execute: (command: AvatarCommand) => Promise<boolean>
  }
) {
  const pill = entryPill(handlers.continueEntry)
  const dialog = entryDialog(choice, handlers.closeDialog, handlers.execute)
  const { backdrop, picker } = dialog
  // 游戏界面快捷栏上的「进入小镇」跟着入口是否可用
  let available = false
  const listeners = new Set<(available: boolean) => void>()
  return {
    pill: pill.pill,
    backdrop,
    picker,
    isOpen: () => !backdrop.hidden,
    close() {
      backdrop.hidden = true
    },
    onAvailable(listener: (available: boolean) => void) {
      listeners.add(listener)
      listener(available)
    },
    /** 打开对话框；回到小镇时填上次的名字和外观（记得自己就带编号，回来还是同一个人） */
    open(self: EntrySelf | null) {
      dialog.setAvatar(self?.id)
      dialog.name.value = self?.name || '旅人'
      if (self) {
        picker.set(self.color)
        dialog.refreshPreview()
      }
      dialog.title.textContent = self ? '回到小镇' : '进入小镇'
      dialog.enter.textContent = self ? '回到上次的位置' : '进入小镇'
      showHint(dialog.hint, !!self)
      backdrop.hidden = false
      pill.pill.hidden = true
      // 触屏上聚焦会弹出键盘盖住半屏，等玩家自己点名字框
      if (!isTouch()) {
        dialog.name.focus()
        dialog.name.select()
      }
    },
    /** 入口按钮跟着控制与连接状态变；进入控制后对话框自动关掉。
     *  supported：这个世界开放了化身控制；actor：本页自己的化身（控制中或记得的自己） */
    render(view: {
      supported: boolean
      controlling: boolean
      online: boolean
      occupied: boolean
      /** 别的页面正在玩的化身有几个：本页只是围观时写在入口按钮上 */
      watching?: number
      actor?: EntrySelf | null
    }) {
      if (view.controlling && !backdrop.hidden) backdrop.hidden = true
      pill.pill.hidden = view.controlling || !backdrop.hidden
      // 别的页面在玩不再挡住本页：一个世界可以有多个化身，本页另开一个自己的。
      pill.pill.disabled = !view.online
      pill.text.textContent = !view.online ? '等小镇连上…' : view.actor ? '继续化身' : '进入化身'
      const watching = view.controlling ? 0 : (view.watching ?? 0)
      pill.sub.textContent =
        view.actor && view.online
          ? watching > 0
            ? `围观中 · ${watching} 人在玩`
            : view.actor.name
          : ''
      const next = view.supported && !pill.pill.disabled
      if (next !== available) {
        available = next
        for (const listener of listeners) listener(next)
      }
      choice.paintDot(pill.dot, view.actor?.color ?? picker.value)
    },
  }
}
