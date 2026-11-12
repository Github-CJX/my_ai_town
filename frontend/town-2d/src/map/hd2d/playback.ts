/** 名册的播放时钟：一份名册在时间轴上代表世界走过了多少「一拍」，播放快慢只按到货快慢慢慢调。
 *
 *  以前按「这一份名册比上一份晚到多少毫秒」加时间轴：网络一卡、浏览器一口气处理好几份名册时，
 *  每份的到达间隔接近 0，那段路就被压进很短的时间轴里，立牌一小段冲刺——看上去正是「卡一下又窜一下」
 *  （见手册 D.47）。现在按世界时钟算：名册带着 sim_minutes 与 pace，世界每拍推进
 *  minutesPerTick × pace 分钟，所以「走了几拍」是算得出来的——被覆盖掉的几份名册同样算进去，
 *  那段路就按几拍的长度播，不会越走越快。
 *
 *  到货快慢只用来放慢（服务端一拍没跟上、浏览器处理得慢），绝不用来加速：一加速就是「窜」。
 *  单独一个文件，好在 node 里喂假时钟验证。 */
export interface PlaybackClockOptions {
  /** 服务端一拍在时间轴上的长度（毫秒） */
  tickMs: number
  /** 世界一拍推进多少模拟分钟（见 host 的 runtime.tick：world.step(0.1 * pace)） */
  minutesPerTick: number
  /** 一份名册最多在时间轴上占多少毫秒：跳得太远就交给重对齐，不慢慢补 */
  maxStepMs: number
  /** 播放比最新一份名册晚多少毫秒：两拍，下一份晚到一拍也还有路可走 */
  delayMs: number
  /** 落后超过这么久就直接跳到最新（切到后台回来、断线重连），不快放 */
  resyncMs: number
  /** 到货统计窗口：一秒里时间轴走了多少 */
  windowMs: number
  /** 按到货速度算出的播放快慢的上下限：到得慢就放慢，到得快不加速 */
  minRate: number
  maxRate: number
  /** 缓冲偏离两拍时最多再快慢多少 */
  maxDrift: number
}

/** 名册上的世界时钟：此刻的分钟数、这一拍推进的倍速 */
export interface PlaybackTick {
  minutes: number
  pace: number
}

export class PlaybackClock {
  /** 最新一份名册在时间轴上的时刻（毫秒） */
  latest = 0
  /** 播放到的时刻：立牌画的是这一刻的位置 */
  play: number
  /** 播放快慢：每来一份名册按到货速度和缓冲调一次 */
  rate = 1
  /** 上一份名册的世界分钟数（还没收到过为 null） */
  private lastMinutes: number | null = null
  /** 到货统计：这一轮从什么时候开始、这一轮时间轴走了多少 */
  private windowStart: number | null = null
  private windowAxis = 0
  /** 按到货速度算出的快慢 */
  private drift = 1

  constructor(private readonly options: PlaybackClockOptions) {
    this.play = -options.delayMs
  }

  /** 收到一份新名册；tick 是名册上的世界时钟，缺了（旧世界）就按一拍算 */
  arrive(now: number, tick?: PlaybackTick) {
    const step = this.stepOf(tick)
    // 停着的世界不再往前，时间轴也停：立牌留在原地，等世界动起来再走
    if (step > 0) {
      this.latest += step
      if (this.windowStart === null) this.windowStart = now
      this.windowAxis += step
      const span = now - this.windowStart
      if (span >= this.options.windowMs) {
        // 一秒里时间轴走了多少就按多少播：一段突发跟随后的空档在窗口里相抵，不算变速
        this.drift = clamp(this.windowAxis / span, this.options.minRate, this.options.maxRate)
        this.windowStart = now
        this.windowAxis = 0
      }
    }
    const buffered = this.latest - this.play
    if (buffered > this.options.resyncMs) {
      this.play = this.latest - this.options.delayMs
      this.rate = 1
    } else {
      const fix = clamp(
        (buffered - this.options.delayMs) / 1000,
        -this.options.maxDrift,
        this.options.maxDrift
      )
      this.rate = this.drift * (1 + fix)
    }
  }

  /** 这一帧走了 dt 毫秒 */
  advance(dt: number) {
    this.play = Math.min(this.latest, this.play + Math.max(0, dt) * this.rate)
  }

  /** 这一份名册在时间轴上代表多少毫秒：按世界走了几拍算，丢掉的几份也算在里头 */
  private stepOf(tick?: PlaybackTick): number {
    const o = this.options
    if (!tick || !Number.isFinite(tick.minutes)) return o.tickMs
    const last = this.lastMinutes
    this.lastMinutes = tick.minutes
    if (last === null) return o.tickMs
    // pace 为零表示世界停着（用户暂停、额度或故障把全镇停下），一拍都不算
    if (!(tick.pace > 0)) return 0
    const beats = (tick.minutes - last) / (o.minutesPerTick * tick.pace)
    if (!(beats > 0)) return 0
    return Math.min(o.maxStepMs, beats * o.tickMs)
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
