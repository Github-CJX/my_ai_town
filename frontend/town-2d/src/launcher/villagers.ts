// 首页建 agent：直接复用镇里那套「新建村民」的编辑器（捏长相、编人设、一句话让模型填），
// 只把最后保存那一步换成存进账号的 agent 定义——定义跟着账号走，投放时才写进某个镇的村民库。
import { button, statusLine } from 'town-shared/dom'
import type { EventsHandle } from 'town-shared/events'
import { errorText } from 'town-shared/format'
import { registerPortraits } from 'town-shared/portraits'
import type { ClientMsg, ResidentTemplate, TemplateFields } from 'town-shared/protocol'
import { renderEditor } from 'town-shared/residents/editor'
import { createResidentsState, type ResidentsContext } from 'town-shared/residents/state'
import {
  type HomeAgent,
  generateVillager,
  makeAgent,
  previewPersona,
  updateAgent,
} from 'town-shared/townApi'
import { villagerArt, villagerPortrait } from '../map/hd2d/villagerSprite'

export type VillagerEditorOptions = {
  /** 改已有的 agent 时传进来；新建不传 */
  agent?: HomeAgent
  /** 页面当前选中的小镇：人设预览与模型生成都借它的世界与工具模型 */
  townId: string | null
  /** 存好之后；joinAfter 为真表示玩家点的是「保存并加入小镇」，接着投放 */
  onSaved: (agent: HomeAgent, joinAfter: boolean) => void
}

export type VillagerEditor = {
  open(options: VillagerEditorOptions): void
  close(): void
}

/** 编辑器只在保存成功时往事件栏写一句；首页没有事件栏，给一套空实现 */
function silentEvents(): EventsHandle {
  return {
    pushLocal: () => {},
    handleMsg: () => false,
    roster: () => {},
    onImportant: () => {},
    recent: () => [],
    setClock: () => {},
    markReset: () => {},
    expanded: () => false,
    expand: () => {},
    collapse: () => {},
  }
}

export function installVillagerEditor(
  dialog: HTMLDialogElement,
  host: HTMLElement
): VillagerEditor {
  // 像素头像完全在浏览器里画，不向世界要图
  registerPortraits({ url: villagerPortrait, art: villagerArt })
  let shut = () => {}
  return {
    open(options) {
      const state = createResidentsState()
      const agent = options.agent
      // 编辑器认的是「模板」：把已有的 agent 定义套成模板形状，改完再存回账号
      const existing: ResidentTemplate | undefined = agent?.fields
        ? {
            template_id: agent.id,
            version: agent.revision,
            builtin: false,
            archived: false,
            fields: agent.fields,
          }
        : undefined

      function render() {
        const handle = renderEditor(ctx, existing, undefined, 'roster')
        // 编辑器自带的返回按钮写着「返回村中居民」：首页没有名册，改成取消
        const back = handle.root.querySelector('button')
        if (back) back.textContent = '取消'
        host.replaceChildren(handle.root)
      }

      const ctx: ResidentsContext = {
        state,
        deps: {
          send: (msg: ClientMsg) => onSend(msg),
          events: silentEvents(),
          localeName: (id) => id,
          onLocate: () => {},
          onFollow: () => {},
          onOpenSettings: () => {},
          modelOptions: () => [],
          connectModel: () => {},
          onJoined: () => {},
          onLibrary: () => {},
          game: false,
          placeNames: () => [],
          onOverlayOpen: () => {},
          canAdd: () => true,
        },
        game: false,
        render,
        setTab: () => dialog.close(),
        newVillager: () => render(),
        showTemplate: () => {},
        startJoin: () => {},
        invite: async () => {},
        joinModel: () => null,
        requestLibrary: () => {},
        close: () => dialog.close(),
        locateButton: () => button('', () => {}),
        setStatus: (target, text, bad = false) => statusLine(target)(text, bad ? 'drop' : ''),
      }

      /** 编辑器的三条消息各走一条 HTTP：生成、预览人设、保存定义 */
      function onSend(msg: ClientMsg) {
        if (msg.type === 'save_resident_template')
          void save(msg.fields, state.editor?.saving ?? '', state.editor?.joinAfterSave ?? false)
        else if (msg.type === 'preview_template_persona') void preview(msg.fields)
        else if (msg.type === 'generate_resident_template') void generate(msg.request_id, msg.brief)
      }

      async function save(fields: TemplateFields, requestId: string, joinAfter: boolean) {
        const editor = state.editor
        if (!editor) return
        try {
          const reply = existing
            ? await updateAgent(existing.template_id, { fields })
            : await makeAgent({ fields })
          if (editor.saving === requestId) editor.saving = null
          dialog.close()
          options.onSaved(reply.agent, joinAfter)
        } catch (error) {
          if (editor.saving === requestId) editor.saving = null
          ctx.setStatus(editor.status, `✗ ${errorText(error)}`, true)
        }
      }

      async function preview(fields: TemplateFields) {
        const editor = state.editor
        if (!editor) return
        if (!options.townId) {
          editor.persona.set('选一个小镇之后，这里显示给 AI 看的人设全文')
          return
        }
        try {
          const reply = await previewPersona(options.townId, fields)
          editor.persona.set(reply.persona || '填写姓名后，这里实时显示给 AI 看的人设')
          if (reply.error) ctx.setStatus(editor.status, reply.error, true)
        } catch (error) {
          editor.persona.set('填写姓名后，这里实时显示给 AI 看的人设')
          ctx.setStatus(editor.status, errorText(error))
        }
      }

      async function generate(requestId: string, brief: string) {
        const editor = state.editor
        if (!editor || editor.generating !== requestId) return
        try {
          if (!options.townId) throw Error('先选一个小镇：用模型生成要用那个小镇的工具模型')
          const reply = await generateVillager(options.townId, brief)
          fill(requestId, reply.ok, reply.message, reply.fields ?? undefined)
        } catch (error) {
          fill(requestId, false, errorText(error))
        }
      }

      /** 生成结果写回表单：成功就整份填进去，失败只把原因挂在按钮旁边 */
      function fill(requestId: string, ok: boolean, message: string, fields?: TemplateFields) {
        const editor = state.editor
        if (!editor || editor.generating !== requestId) return
        editor.generating = null
        editor.gen.disabled = false
        if (ok && fields) {
          editor.fill(fields)
          editor.aiStatus.textContent = `✓ ${message}`
        } else editor.aiStatus.textContent = `✗ ${message}`
      }

      shut = () => {
        if (dialog.open) dialog.close()
      }
      dialog.onclose = () => {
        shut = () => {}
        host.replaceChildren()
      }
      render()
      if (!dialog.open) dialog.showModal()
    },
    close() {
      shut()
    },
  }
}
