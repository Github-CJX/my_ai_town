import type { WalkStep, WalkTarget } from '../gameMap'
// 点击移动：后端只接受方向（avatar_input），没有「走到某点」的命令。
// 路线由地图选好（见 town-2d 的 route.ts），这里逐段走：设好路线和每收到一次化身状态时按最新位置
// 重算方向，到了一个路径点换下一个，遇到门先站到门口再开门。撞墙由后端沿墙滑动；
// 一段路在这么久里几乎没往前走就重新选一次路线，还是不行才算走不过去。

/** 卡住判定按真实时间，不按收到的快照条数：网络拥塞时可能在一瞬间收到多份旧位置，
 *  按条数会误以为已经原地站了许多拍、反复重新规划路线 */
const STUCK_MS = 1300
/** 这段时间里移动不到这么多米才算真的被挡住 */
const MIN_PROGRESS_METRES = 0.035
/** 中途路径点不必踩准：离它这么近、又看得到下一个路径点，就提前转向 */
const WAYPOINT_RADIUS = 1
/** 看不到下一个路径点（拐角那边隔着走不过去的地方）时，要走到离拐角这么近才转向 */
const CORNER_RADIUS = 0.3
/** 门口要站得够近：后端要求离门 1.6 米内才开得了门 */
const PORTAL_RADIUS = 0.6
/** 同一次点击最多重新选路的次数 */
const REPLAN_LIMIT = 2
/** 用预测位置认「到了」时，世界确认的位置也不能离目标更远：差太多说明预测不可信，照旧走 */
const NEAR_SLACK = 0.6
/** 新方向按这个比例混进上一次的方向：世界确认的位置每隔一会校正一次，方向跟着它抖会让化身来回摆；
 *  指数平滑把这种小摆动压平，拐弯靠连续几拍累积照样转得过去（换段时清空，拐角不当场打折） */
const AIM_BLEND = 0.5

type WalkEnd = 'arrived' | 'blocked' | 'cancelled'
interface WalkDeps {
  /** 世界确认的米制位置（不是本地预测）：选方向和判断走不动都只认它，
   *  拿预测位置算会让「校正 → 转向 → 再校正」自己转起来 */
  here: () => WalkTarget | undefined
  /** 画面上小人此刻的位置（本地预测，比世界确认的新一点）：只用来判断「已经到点了」和提前减速。
   *  世界确认的位置比画面晚 0.1~0.4 秒，只用它判断到没到，人其实已经越过目标点，
   *  再掉头走回去、又越过，就在目标点附近绕圈（像被弹力绳牵着）。停下是单向的，用预测不会绕圈。 */
  near?: () => WalkTarget | undefined
  /** 后端一拍走多少米（按现在的步速，奔跑时更多）；暂停时为 0 */
  step: () => number
  /** 现在还能不能走：暂停、正忙、不能动时为假 */
  canWalk: () => boolean
  emit: (direction: [number, number]) => void
  /** 走到门口了：开门。失败就重新选路 */
  portal: (id: string) => Promise<boolean>
  /** 被挡住时重新选路；null 表示确实走不过去 */
  replan: (to: WalkTarget) => WalkStep[] | null
  /** 两点之间的直线能不能走；地图不会判断时不给，当作能走 */
  sees?: (from: WalkTarget, to: WalkTarget) => boolean
  end: (reason: WalkEnd) => void
  /** 测试可注入单调时钟；正常运行用浏览器时钟 */
  now?: () => number
}

export function createWalkTo(deps: WalkDeps) {
  let route: WalkStep[] = []
  let index = 0
  let radius = 0
  let replans = 0
  let opening = false
  let last: [number, number] | null = null
  let stillSince = 0
  const now =
    deps.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()))
  let lastDirection: [number, number] = [0, 0]
  /** 上一次选定的方向（单位向量）：小幅校正不改它，换段时清空 */
  let heading: [number, number] = [0, 0]
  const goal = () => route[route.length - 1]?.point
  /** 画面上小人离某个点还有多远；没有预测、或不在同一空间时给 undefined */
  const drawnDistance = (point: WalkTarget): number | undefined => {
    const drawn = deps.near?.()
    if (!drawn || drawn.space !== point.space) return undefined
    return Math.hypot(point.position[0] - drawn.position[0], point.position[1] - drawn.position[1])
  }
  function rest() {
    last = null
    stillSince = 0
    heading = [0, 0]
  }
  function finish(reason: WalkEnd) {
    if (!route.length) return
    route = []
    index = 0
    opening = false
    rest()
    lastDirection = [0, 0]
    if (reason !== 'cancelled') deps.emit([0, 0])
    deps.end(reason)
  }
  /** 这一段走不动：换一条路线再试，换不出来才放弃 */
  function retry() {
    const target = goal()
    const next = replans < REPLAN_LIMIT && target ? deps.replan(target) : null
    if (!next?.length) return finish('blocked')
    replans++
    route = next
    index = 0
    rest()
    lastDirection = [0, 0]
    // 在下一份新状态和新方向出来之前，不再按已失效的路线盲走
    deps.emit([0, 0])
  }
  return {
    /** steps 是完整路线，最后一个点是真正的目标；radius 是停在目标多远处 */
    set(steps: WalkStep[], stop: number) {
      route = steps
      index = 0
      radius = stop
      replans = 0
      opening = false
      rest()
      lastDirection = [0, 0]
    },
    clear() {
      if (route.length) finish('cancelled')
    },
    /** 只续方向输入，不重复作路径点/被卡判断；服务端 350ms 过期，客户端快照可能晚到。 */
    keepAlive() {
      if (route.length && !opening && deps.canWalk()) deps.emit(lastDirection)
    },
    /** 还没走到终点但已经够得着要找的人或东西：就当走到了 */
    arrive() {
      if (route.length && !opening) finish('arrived')
    },
    /** 设好路线后马上调一次，之后每收到一次化身状态调一次：位置是新的，方向也要重发，
     *  后端 350 毫秒不刷新就归零。已经到了的路径点一并跳过，同一次就朝下一个点出发 */
    tick() {
      if (!route.length || opening) return
      if (!deps.canWalk()) return finish('cancelled')
      const here = deps.here()
      if (!here) return finish('blocked')
      let dx = 0,
        dy = 0,
        distance = 0
      for (;;) {
        const step = route[index]
        if (here.space !== step.point.space) return retry()
        dx = step.point.position[0] - here.position[0]
        dy = step.point.position[1] - here.position[1]
        distance = Math.hypot(dx, dy)
        const corner = !step.portal && index < route.length - 1
        const reach = step.portal ? PORTAL_RADIUS : corner ? WAYPOINT_RADIUS : radius
        // 最后一段：画面上的小人已经进圈就算到了。世界确认的位置慢半拍，等它进圈时人已经走过去了，
        // 再掉头走回来会绕着目标点打圈。这里只用来「停」，不会用来改方向，所以不会自激。
        if (!corner && !step.portal && distance <= reach + NEAR_SLACK) {
          const drawn = drawnDistance(step.point)
          if (drawn !== undefined && drawn <= reach) return finish('arrived')
        }
        if (distance > reach) break
        // 提前转向是抄近路：从这里直奔下一个点要走得通才抄，不然会撞上拐角那边挡着的地方原地不动
        const next = route[index + 1]?.point
        if (corner && distance > CORNER_RADIUS && next && !(deps.sees?.(here, next) ?? true)) break
        if (step.portal) {
          opening = true
          deps.emit([0, 0])
          void deps.portal(step.portal).then((ok) => {
            if (!opening) return
            opening = false
            rest()
            if (!ok) retry()
            else if (++index >= route.length) finish('arrived')
          })
          return
        }
        rest()
        if (++index >= route.length) return finish('arrived')
      }
      const step0 = Math.max(deps.step(), 0.01)
      const time = now()
      if (last) {
        const moved = Math.hypot(here.position[0] - last[0], here.position[1] - last[1])
        if (moved >= MIN_PROGRESS_METRES) {
          last = [...here.position]
          stillSince = time
        } else if (time - stillSince >= STUCK_MS) return retry()
      } else {
        last = [...here.position]
        stillSince = time
      }
      // 剩下不足两拍时按比例缩短向量减速：后端取 n = hypot(方向).max(1)，短向量就是慢速，不会被放大回满速。
      // 用画面上那个更近的距离减速：世界确认的位置慢半拍，等它变近才减速就已经冲过头了。
      const drawn = drawnDistance(route[index].point)
      const remaining = drawn === undefined ? distance : Math.min(distance, drawn)
      const scale = Math.min(1, remaining / (2 * step0))
      const aim: [number, number] = distance > 0 ? [dx / distance, dy / distance] : [0, 0]
      // 位置被校正一点点时方向会跟着摆，平滑一下：只把新方向按 AIM_BLEND 混进旧方向，
      // 免得化身在原地左右抽。换段时 rest() 已经把 heading 清空，拐角照旧当场转。
      // 要掉头（新旧方向夹角超过 90°）时不平滑：掺着旧方向拐大弯会绕着目标点转一圈。
      let direction = aim
      if (distance > 0 && (heading[0] !== 0 || heading[1] !== 0)) {
        const dot = heading[0] * aim[0] + heading[1] * aim[1]
        if (dot >= 0) {
          const mix: [number, number] = [
            heading[0] + (aim[0] - heading[0]) * AIM_BLEND,
            heading[1] + (aim[1] - heading[1]) * AIM_BLEND,
          ]
          const length = Math.hypot(mix[0], mix[1])
          // 新旧方向正好相反时混出来是零向量：那种情况直接朝新方向走
          if (length > 0.001) direction = [mix[0] / length, mix[1] / length]
        }
      }
      heading = direction
      lastDirection = [direction[0] * scale, direction[1] * scale]
      deps.emit(lastDirection)
    },
  }
}
