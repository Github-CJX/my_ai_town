import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../frontend/town-2d/package.json', import.meta.url))
const ts = require('typescript')

test('音效首次 503 失败后，不再每 460ms 重复请求同一个失效文件', () => {
  const source = fs.readFileSync(
    new URL('../../frontend/town-shared/src/audio/effects.ts', import.meta.url),
    'utf8'
  )
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const timers = new Map()
  const audioCreated = []
  const listeners = new Map()
  let time = 1000
  let nextTimer = 0
  class AudioMock {
    constructor(url) {
      this.url = url
      this.listeners = new Map()
      this.paused = false
      audioCreated.push(this)
    }
    addEventListener(name, fn) {
      this.listeners.set(name, fn)
    }
    emit(name) {
      this.listeners.get(name)?.()
    }
    play() {
      return Promise.resolve()
    }
    pause() {
      this.paused = true
    }
    removeAttribute() {}
    load() {}
  }
  const scope = {
    exports: {},
    document: {
      hidden: false,
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener() {},
    },
    Audio: AudioMock,
    Date: { now: () => time },
    setInterval: (fn) => {
      const id = ++nextTimer
      timers.set(id, fn)
      return id
    },
    clearInterval: (id) => timers.delete(id),
    setTimeout: () => 0,
    clearTimeout: () => {},
    require: (id) => {
      if (id === './catalog')
        return {
          EFFECT_ASSETS: {
            footsteps: { outdoor: ['bad.ogg', 'bad.ogg', 'bad.ogg'] },
            ambience: { rain: 'rain.ogg', sleep: 'sleep.m4a' },
            thunder: 'thunder.ogg',
            descend: 'descend.ogg',
          },
          resolveFootstepSurface: () => 'outdoor',
          rainAmbienceVolume: () => 0.2,
        }
      if (id === './scene') return { resolveAudioScene: () => 'day' }
      if (id === './preference') return { readSwitch: () => true, saveSwitch: () => {} }
      throw Error(`unexpected dependency: ${id}`)
    },
  }
  vm.runInNewContext(code, scope)
  const button = { textContent: '', title: '', setAttribute() {}, onclick: null }
  const effects = scope.exports.createEffectsController(button)
  listeners.get('pointerdown')()
  effects.updateMovement({ moving: true, locale: 'outside' })
  assert.equal(audioCreated.length, 1)
  audioCreated[0].emit('error')
  for (let i = 0; i < 100; i++) for (const fn of [...timers.values()]) fn()
  assert.equal(audioCreated.length, 1, '损坏的脚步音效一分钟内不应重复请求')
  time += 60_001
  for (const fn of [...timers.values()]) fn()
  assert.equal(audioCreated.length, 2, '冷却结束后允许轻量重试')
  effects.dispose()
})
