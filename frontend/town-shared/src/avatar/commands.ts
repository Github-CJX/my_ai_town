import type { ClientMsg } from '../protocol'
import type { AvatarCommand, AvatarState } from './types'
import { newId } from '../ids'
/** One connection owns request receipts, timeout and mutation admission. */
export function createAvatarCommands({
  context,
  nextSequence,
  stopMoving,
  showToast,
  send,
}: {
  context: () => { online: boolean; world: string; state: AvatarState | null }
  nextSequence: () => number
  stopMoving: () => void
  showToast: (message: string, sticky?: boolean) => void
  send: (message: ClientMsg) => void | boolean
}) {
  let pendingMutationId: string | null = null
  let pendingMutationKind: AvatarCommand['kind'] | null = null
  // silent：自动发起的命令（恢复上次控制），失败不打扰用户
  const pending = new Map<
    string,
    { finish: (ok: boolean) => void; timer: number; silent: boolean }
  >()
  async function execute(command: AvatarCommand): Promise<boolean> {
    const { online, world, state } = context()
    if (!online || !world) {
      showToast('连接尚未就绪', true)
      return false
    }
    const mutation = !['view', 'heartbeat'].includes(command.kind)
    if (mutation && pendingMutationId) {
      if (command.kind === 'enter' && pendingMutationKind === 'resume') {
        // 用户主动进场优先：背景恢复可能卡在 8 秒超时窗口里。两个命令即使
        // 都送到服务端也会按连接顺序处理，旧恢复回执的状态仍会正常刷新 UI。
        settle(pendingMutationId, false)
        pendingMutationId = null
        pendingMutationKind = null
      } else {
        showToast('上一条化身操作还在等待回执，请稍后重试', true)
        return false
      }
    }
    // 非安全上下文（http://ip:port）没有 crypto.randomUUID，统一走 newId
    const request_id = newId()
    if (mutation) {
      stopMoving()
      pendingMutationId = request_id
      pendingMutationKind = command.kind
    }
    const result = new Promise<boolean>((finish) => {
      const timer = window.setTimeout(() => {
        pending.delete(request_id)
        showToast('尚未收到结果，请先检查连接；不会自动重复执行。', true)
        finish(false)
      }, 8000)
      pending.set(request_id, { finish, timer, silent: command.kind === 'resume' })
    })
    try {
      const delivered = send({
        type: 'avatar',
        world_id: world,
        request_id,
        epoch: state?.epoch ?? '',
        sequence: nextSequence(),
        command,
      })
      if (delivered === false) throw new Error('WebSocket unavailable')
    } catch {
      settle(request_id, false)
      showToast('发送失败，请检查网络连接', true)
    }
    const ok = await result
    // clear() 后旧 Promise 仍会 resolve，不能把刚提交的新请求解锁。
    if (pendingMutationId === request_id) {
      pendingMutationId = null
      pendingMutationKind = null
    }
    return ok
  }

  function settle(requestId: string, ok: boolean) {
    const p = pending.get(requestId)
    if (p) {
      clearTimeout(p.timer)
      pending.delete(requestId)
      p.finish(ok)
    }
    return p
  }
  function clear() {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.finish(false)
    }
    pending.clear()
    pendingMutationId = null
    pendingMutationKind = null
  }
  return {
    execute,
    settle,
    clear,
    get pendingMutation() {
      return pendingMutationId !== null
    },
  }
}
