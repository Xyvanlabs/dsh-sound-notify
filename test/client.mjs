/**
 * 客户端半边的离线自测：用 stub 的 window / document / AudioContext / fetch
 * 把 lib/client.js 当普通脚本跑一遍，验证
 *   轮询 → 收到事件 → 按 scene 选音效 → 合成 → 增益 = 音量
 * 这条链路，以及静音、未知音效、自定义 URL 的分支。
 *
 * 运行：node test/client.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/* ── 记录型 stub ─────────────────────────────────────────────── */
const log = { oscillators: [], files: [], fetches: [], timers: [] }

class FakeGain {
  constructor() {
    this.gain = {
      peak: null,
      setValueAtTime(v) { this.value = v },
      exponentialRampToValueAtTime(v) { this.peak = Math.max(this.peak ?? 0, v) },
    }
  }
  connect() {}
}

class FakeOscillator {
  constructor() {
    this.frequency = { setValueAtTime() {} }
    this.type = 'sine'
    this.startAt = null
    this.stopAt = null
    this.gain = null
    log.oscillators.push(this)
  }
  connect(gain) {
    this.gain = gain
  }
  start(at) { this.startAt = at }
  stop(at) { this.stopAt = at }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running'
    this.currentTime = 10
    this.destination = {}
  }
  createOscillator() { return new FakeOscillator() }
  createGain() { return new FakeGain() }
  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
}

class FakeAudio {
  constructor(src) {
    this.src = src
    this.volume = 1
    this.played = false
  }
  play() {
    this.played = true
    log.files.push({ src: this.src, volume: this.volume })
    return Promise.resolve()
  }
}

const listeners = new Map()
const fetchQueue = []

const window = {
  AudioContext: FakeAudioContext,
  Audio: FakeAudio,
  setTimeout(fn) { log.timers.push(fn); return log.timers.length },
  clearTimeout() {},
  addEventListener(type, fn) { listeners.set(`win:${type}`, fn) },
  fetch(url) {
    log.fetches.push(url)
    const body = fetchQueue.shift()
    if (body === undefined) return Promise.reject(new Error('offline'))
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  },
}

const document = {
  addEventListener(type, fn) { listeners.set(`doc:${type}`, fn) },
  visibilityState: 'visible',
}

let moduleExports = null
const windowShim = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const mod = { exports: {} }
      const require = (name) => {
        if (name === 'react') return {}
        if (name === 'react/jsx-runtime') return {}
        return {}
      }
      const factoryModule = factory(require)
      // factory 返回的 module.exports 才是真正的导出对象
      moduleExports = { id, exports: factoryModule, lastModule: mod }
    },
  },
  AudioContext: FakeAudioContext,
  Audio: FakeAudio,
  setTimeout: window.setTimeout,
  clearTimeout: window.clearTimeout,
  addEventListener: window.addEventListener,
  fetch: window.fetch,
}

const context = vm.createContext({
  window: windowShim,
  document,
  console,
  Promise,
  Array,
  Math,
  String,
  Number,
  Object,
  JSON,
  setTimeout: window.setTimeout,
  clearTimeout: window.clearTimeout,
  fetch: window.fetch,
  Audio: FakeAudio,
})

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

try {
  vm.runInContext(source, context, { filename: 'client.js' })
} catch (error) {
  console.error('client.js 加载失败:', error)
  process.exit(1)
}

check('注册到 __ModuleLoader__', moduleExports !== null && moduleExports.id === 'dsh-sound-notify')
const plugin = moduleExports.exports
check('导出 apply', typeof plugin.apply === 'function')
check('导出 name', plugin.name === 'sound-notify')
check('inject 为空数组', Array.isArray(plugin.inject) && plugin.inject.length === 0)
check('加载时注册了用户手势解锁', listeners.has('doc:pointerdown') && listeners.has('doc:keydown'))

/* ── 首轮 tick：返回游标，不应发声 ───────────────────────────── */
fetchQueue.push({ ok: true, seq: 5, events: [] })
plugin.apply({})
await flush()

check('首轮走了 /sound-notify/events', log.fetches[0] === '/sound-notify/events?since=-1', log.fetches[0])
check('首轮无声音', log.oscillators.length === 0 && log.files.length === 0, `osc=${log.oscillators.length} files=${log.files.length}`)

/* ── 正常结束：两音上行 ─────────────────────────────────────── */
fetchQueue.push({
  ok: true,
  seq: 6,
  events: [{ seq: 6, scene: 'completed', sound: 'completed', volume: 0.5, muted: false }],
})
log.timers.pop()() // 手动触发下一轮
await flush()

check('completed 合成两个振荡器', log.oscillators.length === 2, `osc=${log.oscillators.length}`)
check('completed 用 sine 波形', log.oscillators.every((o) => o.type === 'sine'), log.oscillators.map((o) => o.type).join(','))
check('音量透传为 0.15 (0.3 × 0.5)', near(log.oscillators[0].gain.gain.peak, 0.15), String(log.oscillators[0].gain.gain.peak))
const completedGain = log.oscillators[0].gain.gain.peak

/* ── 中断：两音下行 + 方波 ──────────────────────────────────── */
log.oscillators.length = 0
fetchQueue.push({
  ok: true,
  seq: 7,
  events: [{ seq: 7, scene: 'interrupted', sound: 'interrupted', volume: 0.4, muted: false }],
})
log.timers.pop()()
await flush()

check('interrupted 合成两个振荡器', log.oscillators.length === 2, `osc=${log.oscillators.length}`)
check('interrupted 用 square 波形（与 completed 可辨）', log.oscillators.every((o) => o.type === 'square'), log.oscillators.map((o) => o.type).join(','))
const interruptedGain = log.oscillators[0].gain.gain.peak
check('中断与正常结束使用不同增益/波形', completedGain !== interruptedGain && interruptedGain > 0, `completed=${completedGain} interrupted=${interruptedGain}`)

/* ── 静音事件：不发声 ───────────────────────────────────────── */
log.oscillators.length = 0
fetchQueue.push({ ok: true, seq: 8, events: [{ seq: 8, scene: 'completed', sound: null, volume: 0, muted: true }] })
log.timers.pop()()
await flush()
check('muted 事件不发声', log.oscillators.length === 0 && log.files.length === 0)

/* ── 自定义音效走 <audio> ───────────────────────────────────── */
const before = log.files.length
fetchQueue.push({ ok: true, seq: 9, events: [{ seq: 9, scene: 'completed', sound: 'https://example.com/ding.mp3', volume: 0.3, muted: false }] })
log.timers.pop()()
await flush()
check('自定义 URL 走 <audio>', log.files.length === before + 1 && log.files.at(-1).src === 'https://example.com/ding.mp3', JSON.stringify(log.files.at(-1)))
check('自定义音效音量透传', near(log.files.at(-1).volume, 0.3), String(log.files.at(-1).volume))

/* ── sound:"none" 不发声 ────────────────────────────────────── */
const oscBefore = log.oscillators.length
const filesBefore = log.files.length
fetchQueue.push({ ok: true, seq: 10, events: [{ seq: 10, scene: 'completed', sound: 'none', volume: 0.5, muted: false }] })
log.timers.pop()()
await flush()
check('sound:"none" 静默', log.oscillators.length === oscBefore && log.files.length === filesBefore)

/* ── 一批多事件按序播放 ─────────────────────────────────────── */
log.oscillators.length = 0
fetchQueue.push({
  ok: true,
  seq: 12,
  events: [
    { seq: 11, scene: 'interrupted', sound: 'interrupted', volume: 1, muted: false },
    { seq: 12, scene: 'completed', sound: 'completed', volume: 1, muted: false },
  ],
})
log.timers.pop()()
await flush()
check('一批两条事件播两组音', log.oscillators.length === 4, `osc=${log.oscillators.length}`)

/* ── 游标前进后不会重放 ─────────────────────────────────────── */
log.oscillators.length = 0
fetchQueue.push({ ok: true, seq: 12, events: [] })
log.timers.pop()()
await flush()
const nextUrl = log.fetches.at(-1)
check('下一轮请求带上新游标 since=12', nextUrl.endsWith('since=12'), nextUrl)
check('没有重放旧事件', log.oscillators.length === 0, `osc=${log.oscillators.length}`)

/* ── 网络失败不炸 ───────────────────────────────────────────── */
log.oscillators.length = 0
const timersBefore = log.timers.length
log.timers.pop()() // 队列空 → fetch reject
await flush()
check('网络失败不发声也不中断', log.oscillators.length === 0 && log.timers.length > 0)
/* ── 上下文被重新挂起时必须再 resume，并靠 keepAlive 钉住 ──────── */
check('挂起后会重新 resume（不因「解锁过」就跳过）', source.includes('ac.resume()') && !source.includes('if (unlocked) return;'))
check('有 keepAlive 防止上下文闲置挂起', source.includes('keepAlive'))

function near(a, b, eps = 1e-9) {
  return typeof a === 'number' && Math.abs(a - b) <= eps * 10
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.error('FAILED:', failed.map((item) => item.label).join(' | '))
  process.exit(1)
}
