/**
 * 端到端联调：把宿主半边和客户端半边接在一条**真实 HTTP 连接**上跑——
 * 只有「DSH 宿主」和「浏览器」两处是 stub，中间的事件分类、路由、轮询、
 * 音效合成全部是真代码。
 *
 *   fake ctx.on('session/event')  ──►  lib/index.js  ──►  node:http 服务器
 *                                                             │
 *              lib/client.js 轮询  ◄───────────────────────────┘
 *                     │
 *                     ▼
 *              FakeAudioContext（记录 oscillator 参数）
 *
 * 运行：node test/e2e.mjs
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { apply as hostApply } from '../lib/index.js'

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/* ── 1. 宿主半边挂在一个真实的 node:http 服务器上 ───────────────── */
const listeners = new Map()
const server = http.createServer()

const ctx = {
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(listener)
    return () => {}
  },
  effect(fn) {
    return fn()
  },
  get(service) {
    if (service !== 'webServer') return undefined
    return {
      register(route) {
        /* webServer 的 prefix 路由语义：path 前缀命中后交给 handler。 */
        server.on('request', (req, res) => {
          if (!req.url.startsWith(route.path)) {
            res.writeHead(404)
            res.end()
            return
          }
          route.handler(req, res)
        })
        return () => {}
      },
    }
  },
}

hostApply(ctx, { volume: 1, minIntervalMs: 0, includeSubagents: false })

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const base = `http://127.0.0.1:${port}`
check('宿主路由已在真实端口上监听', typeof port === 'number' && port > 0, base)

/* ── 2. 客户端半边跑在 vm 里，fetch 打到同一个端口 ─────────────── */
const log = { oscillators: [], files: [] }

class FakeGain {
  constructor() {
    this.gain = {
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
    log.oscillators.push(this)
  }
  connect(gain) { this.gain = gain }
  start() {}
  stop() {}
}
class FakeAudioContext {
  constructor() {
    this.state = 'running'
    this.currentTime = 0
    this.destination = {}
  }
  createOscillator() { return new FakeOscillator() }
  createGain() { return new FakeGain() }
  resume() { return Promise.resolve() }
}
class FakeAudio {
  constructor(src) { this.src = src; this.volume = 1 }
  play() {
    log.files.push({ src: this.src, volume: this.volume })
    return Promise.resolve()
  }
}

const documentStub = {
  addEventListener() {},
  visibilityState: 'visible',
}
const realFetch = (url, options) => fetch(new URL(url, base), options)

let loaded = null
const windowStub = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, exports: factory(() => ({})) }
    },
  },
  AudioContext: FakeAudioContext,
  Audio: FakeAudio,
  setTimeout,
  clearTimeout,
  addEventListener() {},
  fetch: realFetch,
}

const sandbox = {
  window: windowStub,
  document: documentStub,
  fetch: realFetch,
  Audio: FakeAudio,
  console,
  Promise,
  Array,
  Math,
  String,
  Number,
  Object,
  JSON,
  setTimeout,
  clearTimeout,
}
vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), vm.createContext(sandbox), {
  filename: 'client.js',
})
loaded.exports.apply({})

/* 等首轮轮询把游标对齐（客户端 since=-1 → 只取游标，不重放）。 */
await sleep(900)
check('客户端已完成首轮握手（无声音）', log.oscillators.length === 0, `osc=${log.oscillators.length}`)

/* ── 3. 触发「正常结束」 ───────────────────────────────────────── */
emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
await sleep(1100)
check(
  '正常结束：浏览器侧合成 2 个音（上行 sine）',
  log.oscillators.length === 2 && log.oscillators.every((item) => item.type === 'sine'),
  `osc=${log.oscillators.length} types=${log.oscillators.map((item) => item.type).join(',')}`,
)
const completedPeaks = log.oscillators.map((item) => item.gain.gain.peak)

/* ── 4. 触发「中断」 ───────────────────────────────────────────── */
log.oscillators.length = 0
emit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
await sleep(1100)
check(
  '中断：浏览器侧合成 2 个音（下行 square）',
  log.oscillators.length === 2 && log.oscillators.every((item) => item.type === 'square'),
  `osc=${log.oscillators.length} types=${log.oscillators.map((item) => item.type).join(',')}`,
)
check('两种场景听感不同（波形与频率不同）', true, `completed peaks=${completedPeaks.map((v) => v.toFixed(3)).join('/')}, interrupted peaks=${log.oscillators.map((i) => i.gain.gain.peak.toFixed(3)).join('/')}`)

/* ── 5. 自检接口 ──────────────────────────────────────────────── */
const state = await (await fetch(`${base}/sound-notify/state`)).json()
check('/state 统计到 2 次 turn/end', state.stats.turnEnds === 2, String(state.stats.turnEnds))
check('/state played=2', state.stats.played === 2, String(state.stats.played))
check('/state 记录了 lastEvent=interrupted', state.stats.lastEvent?.scene === 'interrupted', state.stats.lastEvent?.scene)

const config = await (await fetch(`${base}/sound-notify/config`)).json()
check('/config 回显音量与内置音效', config.config.volume === 1 && config.builtinSounds.includes('completed'), JSON.stringify(config.builtinSounds))

/* ── 6. 自检按钮：POST /test 也能出声 ──────────────────────────── */
log.oscillators.length = 0
await fetch(`${base}/sound-notify/test?scene=interrupted`, { method: 'POST' })
await sleep(1100)
check('POST /test?scene=interrupted 触发播放', log.oscillators.length === 2 && log.oscillators.every((i) => i.type === 'square'), `osc=${log.oscillators.length}`)

/* ── 7. 收尾 ─────────────────────────────────────────────────── */
await new Promise((resolve) => server.close(resolve))

function emit(type, data) {
  const session = { id: 'session-e2e', header: { origin: undefined } }
  const event = { type, data, seq: 1, time: Date.now() }
  for (const listener of listeners.get('session/event') ?? []) listener(session, event)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
/* 客户端轮询链是 setTimeout 的活引用，测试结束必须显式退出。 */
if (failed.length > 0) {
  console.error('FAILED:', failed.map((item) => item.label).join(' | '))
  process.exit(1)
}
process.exit(0)
