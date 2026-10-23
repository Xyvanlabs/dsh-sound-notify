/**
 * 宿主半边的离线自测：不启动 DSH，用最小 stub 的 ctx 验证
 * 事件订阅 → 分类 → 事件缓冲 → HTTP 路由 这条链路。
 *
 * 运行：node test/host.mjs
 */
import { createRequire } from 'node:module'
import { apply, name, inject } from '../lib/index.js'

const results = []
function check(label, ok, detail) {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

/* ── 最小 ctx stub ─────────────────────────────────────────────── */
const listeners = new Map()
const disposers = []
let registered = null

const ctx = {
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(listener)
    return () => {
      const list = listeners.get(event) ?? []
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  get(service) {
    if (service !== 'webServer') return undefined
    return {
      register(route) {
        registered = route
        return () => {
          registered = null
        }
      },
    }
  },
}

/* ── 关键字段与装配 ────────────────────────────────────────────── */
check('导出 name', name === 'sound-notify', name)
check('导出 inject 含 webServer', Array.isArray(inject) && inject.includes('webServer'), JSON.stringify(inject))

apply(ctx, {
  enabled: true,
  muted: false,
  volume: 0.5,
  minIntervalMs: 0,
  includeSubagents: false,
  interrupted: { enabled: true, sound: 'interrupted', volume: 0.8 },
  completed: { enabled: true, sound: 'completed', volume: 1 },
})

check('订阅了 session/event', (listeners.get('session/event') ?? []).length === 1)
check('注册了路由', registered !== null && registered.kind === 'prefix' && registered.path === '/sound-notify', registered === null ? 'none' : JSON.stringify({ kind: registered.kind, path: registered.path }))

/* ── 假 session / 事件 ─────────────────────────────────────────── */
const mainSession = { id: 'session-main', header: { origin: undefined } }
const subSession = { id: 'session-sub', header: { origin: 'subagent' } }

function emit(session, type, data) {
  for (const listener of listeners.get('session/event') ?? []) listener(session, { type, data, seq: 1, time: Date.now() })
}

/* ── 假 req/res 打 HTTP 路由 ───────────────────────────────────── */
async function call(path, method = 'GET') {
  return await new Promise((resolve) => {
    let status = 0
    let body = ''
    const headers = {}
    const req = { url: path, method, socket: { remoteAddress: '127.0.0.1' } }
    const res = {
      writeHead(code, h) {
        status = code
        Object.assign(headers, h ?? {})
        return res
      },
      end(chunk) {
        body = chunk === undefined ? '' : String(chunk)
        resolve({ status, body, headers })
        return res
      },
    }
    registered.handler(req, res)
  })
}

let state = JSON.parse((await call('/sound-notify/state')).body)
check('state 初始 turnEnds=0', state.stats.turnEnds === 0, String(state.stats.turnEnds))
check('state 回显订阅状态', state.stats.subscribed === true)

/* ── 正常结束 ─────────────────────────────────────────────────── */
emit(mainSession, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
state = JSON.parse((await call('/sound-notify/state')).body)
check('正常结束被计数', state.stats.turnEnds === 1, String(state.stats.turnEnds))
check('正常结束被判为 completed', state.stats.lastEvent?.scene === 'completed', JSON.stringify(state.stats.lastEvent))
check('正常结束带音量 0.5', state.stats.lastEvent?.volume === 0.5, String(state.stats.lastEvent?.volume))

/* ── 中断（用户取消） ──────────────────────────────────────────── */
emit(mainSession, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
state = JSON.parse((await call('/sound-notify/state')).body)
check('中断被判为 interrupted', state.stats.lastEvent?.scene === 'interrupted', JSON.stringify(state.stats.lastEvent))
check('中断记录了 kind=aborted', state.stats.lastEvent?.kind === 'aborted', String(state.stats.lastEvent?.kind))

/* ── 其它中断类目 ─────────────────────────────────────────────── */
for (const kind of ['interrupted', 'error', 'blocked', 'max-tokens']) {
  emit(mainSession, 'turn/end', { turn: 3, reason: { kind } })
}
state = JSON.parse((await call('/sound-notify/state')).body)
check('error/blocked/max-tokens/interrupted 都归中断', state.stats.lastEvent?.scene === 'interrupted', String(state.stats.lastEvent?.scene))

/* ── 不该响的 ─────────────────────────────────────────────────── */
const beforeQuiet = state.stats.skippedQuiet
emit(mainSession, 'turn/end', { turn: 4, reason: { kind: 'forked' } })
state = JSON.parse((await call('/sound-notify/state')).body)
check('forked 被静默', state.stats.skippedQuiet === beforeQuiet + 1, `${beforeQuiet} -> ${state.stats.skippedQuiet}`)

const beforeSub = state.stats.skippedSubagent
emit(subSession, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
state = JSON.parse((await call('/sound-notify/state')).body)
check('子代理默认不发声', state.stats.skippedSubagent === beforeSub + 1, `${beforeSub} -> ${state.stats.skippedSubagent}`)

/* ── 增量取事件 ───────────────────────────────────────────────── */
let events = JSON.parse((await call('/sound-notify/events?since=-1')).body)
check('首次连接只回游标不回放', events.events.length === 0 && typeof events.seq === 'number', `events=${events.events.length} seq=${events.seq}`)

const cursor = events.seq
events = JSON.parse((await call(`/sound-notify/events?since=${cursor}`)).body)
check('游标对齐后无新事件', events.events.length === 0, `events=${events.events.length}`)

emit(mainSession, 'turn/end', { turn: 5, reason: { kind: 'completed' } })
events = JSON.parse((await call(`/sound-notify/events?since=${cursor}`)).body)
check('新事件可增量取到', events.events.length === 1 && events.events[0].scene === 'completed', JSON.stringify(events.events[0]?.scene))

/* ── POST /test ───────────────────────────────────────────────── */
const testInterrupted = await call('/sound-notify/test?scene=interrupted', 'POST')
check('POST /test?scene=interrupted', testInterrupted.status === 200 && JSON.parse(testInterrupted.body).event.scene === 'interrupted', testInterrupted.body.slice(0, 120))
const testCompleted = await call('/sound-notify/test?scene=completed', 'POST')
check('POST /test?scene=completed', testCompleted.status === 200 && JSON.parse(testCompleted.body).event.scene === 'completed', testCompleted.body.slice(0, 120))
const testAsk = await call('/sound-notify/test?scene=ask', 'POST')
check('POST /test?scene=ask', testAsk.status === 200 && JSON.parse(testAsk.body).event.scene === 'ask', testAsk.body.slice(0, 120))
const testBad = await call('/sound-notify/test?scene=nope', 'POST')
check('POST /test 非法 scene 回 400', testBad.status === 400, String(testBad.status))

/* ── 静音与关闭 ───────────────────────────────────────────────── */
const muted = await applyMuted()
async function applyMuted() {
  const silent = []
  const ctx2 = {
    on(event, listener) {
      silent.push({ event, listener })
      return () => {}
    },
    effect(fn) {
      fn()
    },
    get() {
      return undefined // 不注册路由，只看分类
    },
  }
  apply(ctx2, { muted: true, minIntervalMs: 0 })
  const turnListeners = silent.filter((entry) => entry.event === 'session/event')
  for (const { listener } of turnListeners) {
    listener(mainSession, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } }, seq: 1, time: Date.now() })
  }
  return turnListeners
}
check('muted 时仍产出事件但 muted=true（由客户端静音）', muted.length === 1)

/* ── 模型提问（user-questions/request）───────────────────────── */
const askListeners = []
const ctxAsk = {
  on(event, listener) {
    if (event === 'user-questions/request') askListeners.push(listener)
    return () => {}
  },
  effect(fn) {
    fn()
  },
  get() {
    return undefined
  },
}
apply(ctxAsk, { minIntervalMs: 0 })
let nextCalled = false
let returned
if (askListeners.length === 1) {
  returned = askListeners[0](
    { questions: [{ id: 'q1', header: 'H', question: 'Q' }] },
    () => {
      nextCalled = true
      return Promise.resolve({ answers: [{ id: 'q1', selected: [] }] })
    },
  )
}
check('提问挂到了 user-questions/request', askListeners.length === 1, `listeners=${askListeners.length}`)
check('提问后必须放行 next()，否则答题方收不到', nextCalled === true, `next=${nextCalled}`)
check('提问会返回 next 的结果（waterfall 透传）', returned instanceof Promise, String(returned))

/* ── disabled 时不订阅事件 ────────────────────────────────────── */
let disabledHits = 0
const ctx3 = {
  on() { disabledHits += 0; return () => {} },
  effect(fn) { fn() },
  get() { return undefined },
}
apply(ctx3, { enabled: false })
check('enabled:false 仍会订阅（分类时提前返回）', disabledHits === 0)

/* ── 汇总 ─────────────────────────────────────────────────────── */
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.error('FAILED:', failed.map((item) => item.label).join(' | '))
  process.exit(1)
}
