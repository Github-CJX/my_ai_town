import type { WeatherKind } from '../weather/types'
import { EFFECT_ASSETS, rainAmbienceVolume, resolveFootstepSurface } from './catalog'
import { resolveAudioScene } from './scene'
import { readSwitch, saveSwitch } from './preference'

const ENABLED_KEY = 'ai-town:effects-enabled'
const STEP_INTERVAL_MS = 460
/** 音效资源发生 503/网络错误后暂停重新请求；避免每走一步都重复刷失败的 GET。 */
const AUDIO_RETRY_MS = 60_000

/** 首页没有音效可放：首页「设定」只改这个开关，进小镇后按它播放 */
export const effectsPreference = {
  enabled: () => readSwitch(ENABLED_KEY),
  toggle: () => saveSwitch(ENABLED_KEY, !readSwitch(ENABLED_KEY)),
}

export interface MovementSoundState {
  moving: boolean
  locale: string
  space?: string
  atKind?: string
}

export function createEffectsController(button: HTMLButtonElement) {
  let enabled = readSwitch(ENABLED_KEY)
  let unlocked = false
  let clock = '12:00'
  let weather: WeatherKind | undefined
  let movement: MovementSoundState = { moving: false, locale: '' }
  let ambientKind: 'rain' | 'sleep' | null = null
  let ambient: HTMLAudioElement | null = null
  let stepTimer: ReturnType<typeof setInterval> | undefined
  let thunderTimer: ReturnType<typeof setTimeout> | undefined
  let lastStep = -1
  const oneShots = new Set<HTMLAudioElement>()
  const failedUntil = new Map<string, number>()
  const unavailable = (url: string) => (failedUntil.get(url) ?? 0) > Date.now()
  const failed = (url: string) => failedUntil.set(url, Date.now() + AUDIO_RETRY_MS)

  const updateButton = () => {
    // 写明是音效、开着还是关着：只有符号时分不清音乐和音效，也看不出是状态还是按钮
    button.textContent = enabled ? '♪ 音效：开' : '♪ 音效：关'
    button.setAttribute('aria-label', enabled ? '音效：开' : '音效：关')
    button.setAttribute('aria-pressed', String(enabled))
    button.title = enabled
      ? '环境音与化身音效已开启（点击关闭）'
      : '环境音与化身音效已关闭（点击开启）'
  }
  const release = (audio: HTMLAudioElement) => {
    oneShots.delete(audio)
    audio.removeAttribute('src')
    audio.load()
  }
  const playOne = (url: string, volume: number) => {
    if (!enabled || !unlocked || document.hidden || unavailable(url)) return
    const audio = new Audio(url)
    audio.volume = volume
    oneShots.add(audio)
    audio.addEventListener('ended', () => release(audio), { once: true })
    audio.addEventListener(
      'error',
      () => {
        failed(url)
        release(audio)
      },
      { once: true }
    )
    void audio.play().catch((error) => {
      // 用户尚未允许自动播放不是资源故障；网络/解码失败则退避。
      if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') failed(url)
      release(audio)
    })
  }
  const stopAmbient = () => {
    ambient?.pause()
    ambient?.removeAttribute('src')
    ambient?.load()
    ambient = null
    ambientKind = null
  }
  const syncAmbient = () => {
    const scene = resolveAudioScene(clock, weather)
    const nextKind =
      scene === 'rain' || scene === 'thunderstorm' ? 'rain' : scene === 'sleep' ? 'sleep' : null
    if (!enabled || !unlocked || document.hidden || !nextKind) {
      stopAmbient()
      return
    }
    const url = EFFECT_ASSETS.ambience[nextKind]
    if (unavailable(url)) {
      stopAmbient()
      return
    }
    const volume = nextKind === 'rain' ? rainAmbienceVolume(weather) : 0.1
    if (ambient && ambientKind === nextKind) {
      ambient.volume = volume
      if (ambient.paused) void ambient.play().catch(() => {})
      return
    }
    stopAmbient()
    ambientKind = nextKind
    ambient = new Audio(url)
    const playing = ambient
    playing.addEventListener(
      'error',
      () => {
        failed(url)
        if (ambient === playing) stopAmbient()
      },
      { once: true }
    )
    ambient.loop = true
    ambient.preload = 'auto'
    ambient.volume = volume
    void playing.play().catch((error) => {
      if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') failed(url)
      if (ambient === playing) stopAmbient()
    })
  }
  const clearThunder = () => {
    if (thunderTimer) clearTimeout(thunderTimer)
    thunderTimer = undefined
  }
  const scheduleThunder = () => {
    clearThunder()
    if (!enabled || !unlocked || document.hidden || weather !== 'thunderstorm') return
    thunderTimer = setTimeout(
      () => {
        playOne(EFFECT_ASSETS.thunder, 0.42)
        scheduleThunder()
      },
      8000 + Math.random() * 16000
    )
  }
  const step = () => {
    if (!movement.moving) return
    const surface = resolveFootstepSurface(
      movement.locale,
      movement.space,
      movement.atKind,
      weather
    )
    const variants = EFFECT_ASSETS.footsteps[surface]
    lastStep = (lastStep + 1 + Math.floor(Math.random() * (variants.length - 1))) % variants.length
    playOne(variants[lastStep], surface === 'indoor' ? 0.24 : 0.2)
  }
  const syncSteps = () => {
    if (stepTimer) clearInterval(stepTimer)
    stepTimer = undefined
    if (!enabled || !unlocked || document.hidden || !movement.moving) return
    step()
    stepTimer = setInterval(step, STEP_INTERVAL_MS)
  }
  const stopAll = () => {
    stopAmbient()
    clearThunder()
    if (stepTimer) clearInterval(stepTimer)
    stepTimer = undefined
    for (const audio of oneShots) {
      audio.pause()
      release(audio)
    }
  }
  const unlock = () => {
    unlocked = true
    syncAmbient()
    scheduleThunder()
    syncSteps()
  }
  const onFirstGesture = () => unlock()
  const onVisibility = () => {
    if (document.hidden) stopAll()
    else if (enabled && unlocked) unlock()
  }
  document.addEventListener('pointerdown', onFirstGesture, { capture: true, once: true })
  document.addEventListener('keydown', onFirstGesture, { capture: true, once: true })
  document.addEventListener('visibilitychange', onVisibility)
  const toggle = () => {
    unlocked = true
    enabled = !enabled
    saveSwitch(ENABLED_KEY, enabled)
    if (enabled) unlock()
    else stopAll()
    updateButton()
  }
  button.onclick = (event) => {
    event.stopPropagation()
    toggle()
  }
  updateButton()

  return {
    enabled: () => enabled,
    toggle,
    updateEnvironment(nextClock: string, nextWeather?: WeatherKind) {
      const changed = weather !== nextWeather
      clock = nextClock
      weather = nextWeather
      syncAmbient()
      if (changed) {
        scheduleThunder()
        syncSteps()
      }
    },
    updateMovement(next: MovementSoundState) {
      const changed =
        next.moving !== movement.moving ||
        next.locale !== movement.locale ||
        next.space !== movement.space ||
        next.atKind !== movement.atKind
      movement = next
      if (changed) syncSteps()
    },
    playDescend() {
      playOne(EFFECT_ASSETS.descend, 0.38)
    },
    dispose() {
      document.removeEventListener('pointerdown', onFirstGesture, true)
      document.removeEventListener('keydown', onFirstGesture, true)
      document.removeEventListener('visibilitychange', onVisibility)
      button.onclick = null
      stopAll()
    },
  }
}
