/**
 * dsh-sound-notify — host half.
 *
 * 订阅宿主事件 `session/event`，筛出每一轮对话的结束事件 `turn/end`，读取
 * `event.data.reason.kind`（TurnEndReasonMap 七个成员之一），把「用户中断」
 * 与「正常结束」分成两类，写进一个环形事件缓冲，并通过 webServer 暴露的
 * 轮询接口交给浏览器侧播放提示音。
 *
 * 为什么分类必须在宿主做：`turn/end.reason` 只存在于宿主事件的载荷里，浏览器
 * 侧的 `sessions` 快照只有 `running` 布尔的翻转，拿不到结束原因，无法区分
 * “被打断”和“跑完了”。
 *
 * 路由（全部只允许回环地址访问）：
 *   GET  /sound-notify/events?since=N  增量事件（浏览器每 600ms 轮询一次）
 *   GET  /sound-notify/config          生效配置 + 内置音效清单
 *   GET  /sound-notify/state           自检信息（订阅状态、计数、最近事件）
 *   POST /sound-notify/test            投放一条合成事件，走同一条播放链路
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'sound-notify'
export const inject = ['webServer']

/** 本插件独占的 HTTP 路由前缀。 */
const ROOT = '/sound-notify'
/** 宿主半边版本号，`/state` 会回显它，便于确认装的是哪一版。 */
const VERSION = '1.0.0'
/** 环形缓冲容量：足够覆盖浏览器一整屏时间不轮询时的补发，又不会无限增长。 */
const RING = 100

/** 配置默认值。patch 行里只写想改的字段即可。 */
const DEFAULTS = {
  /** 总开关：false 时宿主连事件都不再产生。 */
  enabled: true,
  /** 静音：仍产生事件、仍计数，只是不发声（便于确认链路活着）。 */
  muted: false,
  /** 全局音量 0..1，与各场景音量相乘。 */
  volume: 0.7,
  /** 两条事件之间的最小间隔，抑制同一瞬间多会话齐响。 */
  minIntervalMs: 500,
  /** 子代理会话是否也发声。默认关：一次主对话会带出很多子代理轮次。 */
  includeSubagents: false,
  /** 归为「中断」音的结束原因。 */
  interruptedKinds: ['aborted', 'interrupted', 'error', 'blocked', 'max-tokens'],
  /** 归为「正常结束」音的结束原因。 */
  completedKinds: ['completed'],
  /** 完全不发声的结束原因（fork 会制造一条 turn/end，但用户并没有看到结束）。 */
  quietKinds: ['forked'],
  /** 中断场景。sound 可以是内置音效名，也可以是一个音频 URL。 */
  interrupted: { enabled: true, sound: 'interrupted', volume: 1 },
  /** 正常结束场景。 */
  completed: { enabled: true, sound: 'completed', volume: 1 },
  /**
   * 模型向你提问、等你输入时。默认借用「中断」的下行音：
   * 它不是结束，而是「轮到你说话」——需要你介入，所以用同一个警示音。
   */
  ask: { enabled: true, sound: 'interrupted', volume: 1 },
}

/** 与 profile 的 package.json 同一套目标目录解析：优先跟 `DSH_HOME`。 */
function dshHome() {
  return process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/** 内置音效名清单，`/config` 回给前端做自检。 */
const BUILTIN_SOUNDS = ['completed', 'interrupted', 'beep', 'none']

/** 只接受本机回环访问：文档代理与页面同源，跨机请求一律拒绝。 */
function isLoopback(req) {
  const address = req.socket === null || req.socket === undefined ? undefined : req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function reply(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  })
  res.end(body)
}

/** 逐字段对齐类型，避免 patch 里写错一个字段就把整份配置拖垮。 */
function normalizeConfig(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const num = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  }
  const strings = (value, fallback) =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string') : fallback
  const scene = (value, fallback) => {
    const s = value !== null && typeof value === 'object' ? value : {}
    return {
      enabled: bool(s.enabled, fallback.enabled),
      sound: typeof s.sound === 'string' && s.sound.trim() !== '' ? s.sound.trim() : fallback.sound,
      volume: num(s.volume, fallback.volume, 0, 1),
    }
  }
  return {
    enabled: bool(src.enabled, DEFAULTS.enabled),
    muted: bool(src.muted, DEFAULTS.muted),
    volume: num(src.volume, DEFAULTS.volume, 0, 1),
    minIntervalMs: num(src.minIntervalMs, DEFAULTS.minIntervalMs, 0, 10000),
    includeSubagents: bool(src.includeSubagents, DEFAULTS.includeSubagents),
    interruptedKinds: strings(src.interruptedKinds, DEFAULTS.interruptedKinds),
    completedKinds: strings(src.completedKinds, DEFAULTS.completedKinds),
    quietKinds: strings(src.quietKinds, DEFAULTS.quietKinds),
    interrupted: scene(src.interrupted, DEFAULTS.interrupted),
    completed: scene(src.completed, DEFAULTS.completed),
    ask: scene(src.ask, DEFAULTS.ask),
  }
}

/** 从 `TurnEndReason` 里取出 kind，兼容字符串与 `{ kind }` 两种形态。 */
function reasonKind(reason) {
  if (reason === null || reason === undefined) return 'unknown'
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return 'unknown'
}

/**
 * 把结束原因归到两个可播放的桶。
 * @returns {'interrupted' | 'completed' | null} null 表示这条事件不发声。
 */
function classify(kind, cfg) {
  if (cfg.quietKinds.includes(kind)) return null
  if (cfg.completedKinds.includes(kind)) return 'completed'
  if (cfg.interruptedKinds.includes(kind)) return 'interrupted'
  return null
}

/** 把配置里的场景换算成一次具体的播放指令。 */
function playDirective(cfg, scene) {
  if (!cfg.enabled || cfg.muted) return null
  const sceneCfg = cfg[scene]
  if (sceneCfg === undefined || sceneCfg.enabled !== true) return null
  const volume = Math.round(cfg.volume * sceneCfg.volume * 1000) / 1000
  if (volume <= 0) return null
  return { sound: sceneCfg.sound, volume }
}

export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig)

  /** 自检计数，`/state` 直接吐出去。 */
  const stats = {
    version: VERSION,
    subscribed: false,
    turnEnds: 0,
    /** 模型向你提问（user-questions/request）的次数，含被节流掉的。 */
    asked: 0,
    /** `user-questions/request` 是否注册成功；用于排查「提问没响」。 */
    askSubscribed: false,
    /** `tools/pre-execute` 是否注册成功。 */
    toolHookSubscribed: false,
    /** 诊断：见过的 session 事件类型计数。 */
    eventTypes: {},
    /** 诊断：见过的工具调用名计数（只记前 64 个不同名字）。 */
    toolCalls: {},
    played: 0,
    skippedQuiet: 0,
    skippedSubagent: 0,
    skippedThrottled: 0,
    skippedSilent: 0,
    eventsRequests: 0,
    lastPollAt: null,
    lastEvent: null,
    /** 浏览器侧回执：真正执行了播放的条数。这是「有没有响」的客观证据。 */
    acked: 0,
    lastAck: null,
    /** 浏览器侧报告：AudioContext 处于 suspended，音效被自动播放策略拦下。 */
    audioBlocked: false,
    lastError: null,
  }

  /**
   * seq 单调递增；浏览器用 `since` 增量取事件。
   * 起点用时间戳而不是 0：插件热重载后计数器会归零，若仍从 0 开始，
   * 浏览器手里的旧游标（比如 1）会永远大于等于它，新事件就被静默丢掉。
   */
  let seq = Date.now()
  const ring = []
  let lastPlayedAt = 0

  const logDir = join(dshHome(), 'sound-notify')
  const logFile = join(logDir, 'activity.jsonl')
  let logReady = false

  /** 一行一条的落地日志：验证「确实判别成了中断」时直接看这个文件。 */
  function log(record) {
    try {
      if (!logReady) {
        mkdirSync(logDir, { recursive: true })
        logReady = true
      }
      appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  function push(scene, detail) {
    const directive = playDirective(cfg, scene)
    seq += 1
    const event = {
      seq,
      scene,
      at: new Date().toISOString(),
      sound: directive === null ? null : directive.sound,
      volume: directive === null ? 0 : directive.volume,
      muted: directive === null,
      reason: detail.reason,
      kind: detail.kind,
      turn: detail.turn,
      sessionId: detail.sessionId,
      origin: detail.origin,
      source: detail.source,
    }
    ring.push(event)
    while (ring.length > RING) ring.shift()
    if (directive !== null) {
      stats.played += 1
      lastPlayedAt = Date.now()
    } else {
      stats.skippedSilent += 1
    }
    stats.lastEvent = event
    log(event)
    return event
  }

  /** 主链路：宿主事件 -> 分类 -> 事件缓冲。 */
  function onSessionEvent(session, event) {
    try {
      if (event !== null && typeof event === 'object' && typeof event.type === 'string') {
        const seen = stats.eventTypes[event.type]
        if (seen === undefined) {
          if (Object.keys(stats.eventTypes).length < 64) stats.eventTypes[event.type] = 1
        } else {
          stats.eventTypes[event.type] = seen + 1
        }
      }
      if (!cfg.enabled) return
      if (event === null || typeof event !== 'object' || event.type !== 'turn/end') return
      stats.turnEnds += 1

      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const kind = reasonKind(data.reason)
      const origin = session !== null && session !== undefined && session.header !== null && session.header !== undefined
        ? session.header.origin
        : undefined
      const sessionId = session !== null && session !== undefined && typeof session.id === 'string' ? session.id : undefined

      if (origin === 'subagent' && !cfg.includeSubagents) {
        stats.skippedSubagent += 1
        log({ at: new Date().toISOString(), skipped: 'subagent', kind, sessionId })
        return
      }

      const scene = classify(kind, cfg)
      if (scene === null) {
        stats.skippedQuiet += 1
        log({ at: new Date().toISOString(), skipped: 'quiet', kind, sessionId })
        return
      }

      const now = Date.now()
      if (now - lastPlayedAt < cfg.minIntervalMs) {
        stats.skippedThrottled += 1
        log({ at: new Date().toISOString(), skipped: 'throttled', kind, sessionId })
        return
      }

      push(scene, { reason: data.reason, kind, turn: data.turn, sessionId, origin, source: 'session/event' })
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * 模型向你提问、等你输入：这条路不产生 `turn/end`（轮次还开着），
   * 所以必须单独挂 `user-questions/request`，否则问完你什么也听不到。
   */
  /** 播放「轮到你」提示音，两条触发路径（提问事件 / 提问工具调用）共用，靠节流去重。 */
  function notifyAwaiting(source) {
    stats.asked += 1
    try {
      if (!cfg.enabled) return
      const now = Date.now()
      if (now - lastPlayedAt < cfg.minIntervalMs) {
        stats.skippedThrottled += 1
        log({ at: new Date().toISOString(), skipped: 'throttled', kind: 'awaiting-input', source })
        return
      }
      push('ask', {
        reason: { kind: 'awaiting-input' },
        kind: 'awaiting-input',
        turn: undefined,
        sessionId: undefined,
        origin: 'ask',
        source,
      })
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  function onUserQuestion(_request, next) {
    notifyAwaiting('user-questions/request')
    // waterfall 事件：必须把控制权交回去，否则提问到不了答题方。
    return typeof next === 'function' ? next() : undefined
  }

  /**
   * 提问工具的兜底路径：某些图形界面里提问不经过 `user-questions/request`，
   * 只在工具调度时出现一次 `ask_user_question`，所以这里也挂一手。
   */
  function toolNameOf(exec) {
    if (exec === null || typeof exec !== 'object') return undefined
    if (typeof exec.name === 'string') return exec.name
    if (exec.tool !== null && typeof exec.tool === 'object' && typeof exec.tool.name === 'string') return exec.tool.name
    if (typeof exec.tool === 'string') return exec.tool
    return undefined
  }

  function isAskTool(name) {
    if (typeof name !== 'string') return false
    return name === 'ask_user_question' || name.endsWith('__ask_user_question')
  }

  function onPreExecute(exec, next) {
    try {
      const name = toolNameOf(exec)
      if (typeof name === 'string') {
        if (stats.toolCalls[name] === undefined && Object.keys(stats.toolCalls).length < 64) {
          stats.toolCalls[name] = 0
        }
        if (stats.toolCalls[name] !== undefined) stats.toolCalls[name] += 1
        if (isAskTool(name)) notifyAwaiting('tools/pre-execute')
      }
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error)
    }
    return typeof next === 'function' ? next() : undefined
  }

  // 订阅宿主事件。`session/event` 是 emit 模式的 Host Event，不需要 inject 列表。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const dispose = ctx.on('session/event', onSessionEvent)
      stats.subscribed = true
      return () => {
        stats.subscribed = false
        if (typeof dispose === 'function') dispose()
      }
    }, 'sound-notify: session/event subscription')
  } else {
    const dispose = ctx.on('session/event', onSessionEvent)
    stats.subscribed = true
    ctx.on('dispose', () => {
      if (typeof dispose === 'function') dispose()
    })
  }

  // waterfall 事件：用 function 而非箭头函数，保留 Cordis 绑定的 `this`。
  let offAsk
  try {
    offAsk = ctx.on('user-questions/request', function (request, next) {
      return onUserQuestion(request, next)
    })
    stats.askSubscribed = true
  } catch (error) {
    stats.askSubscribed = false
    stats.lastError = error instanceof Error ? error.message : String(error)
  }
  if (typeof offAsk === 'function') {
    if (typeof ctx.effect === 'function') {
      ctx.effect(
        () => () => offAsk(),
        'sound-notify: user-questions/request subscription',
      )
    } else {
      ctx.on('dispose', () => offAsk())
    }
  }

  // 工具调度侧的兜底钩子（同时兼职诊断：记录见过的工具名）。
  let offTool
  try {
    offTool = ctx.on('tools/pre-execute', function (exec, next) {
      return onPreExecute(exec, next)
    })
    stats.toolHookSubscribed = true
  } catch (error) {
    stats.toolHookSubscribed = false
    stats.lastError = error instanceof Error ? error.message : String(error)
  }
  if (typeof offTool === 'function') {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => offTool(), 'sound-notify: tools/pre-execute subscription')
    } else {
      ctx.on('dispose', () => offTool())
    }
  }

  function handle(req, res) {
    if (!isLoopback(req)) {
      reply(res, 403, { ok: false, error: 'loopback only' })
      return
    }
    let path = '/'
    let query = ''
    try {
      const url = new URL(req.url === undefined || req.url === null ? '/' : req.url, 'http://127.0.0.1')
      path = url.pathname.slice(ROOT.length) || '/'
      query = url.search
    } catch {
      reply(res, 400, { ok: false, error: 'bad url' })
      return
    }

    if (path === '/events') {
      if (req.method !== 'GET') {
        reply(res, 405, { ok: false, error: 'only GET is allowed' })
        return
      }
      const sinceRaw = new URLSearchParams(query).get('since')
      const since = sinceRaw === null || sinceRaw === '' ? -1 : Number(sinceRaw)
      stats.eventsRequests += 1
      stats.lastPollAt = new Date().toISOString()
      // 首次连接（since 缺省 / 负数 / 落后太多）只回游标，不回放历史，
      // 否则刷新页面会把最近 100 条事件一次性响一遍。
      if (!Number.isFinite(since) || since < 0 || (ring.length > 0 && since < ring[0].seq - 1)) {
        reply(res, 200, { ok: true, seq, events: [] })
        return
      }
      reply(res, 200, { ok: true, seq, events: ring.filter((item) => item.seq > since) })
      return
    }

    if (path === '/config') {
      if (req.method !== 'GET') {
        reply(res, 405, { ok: false, error: 'only GET is allowed' })
        return
      }
      reply(res, 200, { ok: true, version: VERSION, config: cfg, builtinSounds: BUILTIN_SOUNDS })
      return
    }

    if (path === '/state') {
      if (req.method !== 'GET') {
        reply(res, 405, { ok: false, error: 'only GET is allowed' })
        return
      }
      reply(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        log: logFile,
        config: cfg,
        stats: { ...stats, buffered: ring.length, seq },
      })
      return
    }

    if (path === '/test') {
      if (req.method !== 'POST') {
        reply(res, 405, { ok: false, error: 'only POST is allowed' })
        return
      }
      const scene = new URLSearchParams(query).get('scene')
      const SCENE_KINDS = { interrupted: 'aborted', completed: 'completed', ask: 'awaiting-input' }
      const kind = SCENE_KINDS[scene]
      if (kind === undefined) {
        reply(res, 400, { ok: false, error: 'scene must be interrupted, completed or ask' })
        return
      }
      const event = push(scene, { reason: { kind }, kind, turn: -1, sessionId: 'self-test', origin: 'test', source: 'self-test' })
      reply(res, 200, { ok: true, event })
      return
    }

    // 浏览器播完后回执，让「有没有真的响」在宿主侧可查。
    if (path === '/ack') {
      if (req.method !== 'POST') {
        reply(res, 405, { ok: false, error: 'only POST is allowed' })
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 4096) body = body.slice(0, 4096)
      })
      req.on('end', () => {
        try {
          const payload = body === '' ? {} : JSON.parse(body)
          stats.acked += 1
          stats.lastAck = {
            at: new Date().toISOString(),
            seq: typeof payload.seq === 'number' ? payload.seq : null,
            scene: typeof payload.scene === 'string' ? payload.scene : null,
            sound: typeof payload.sound === 'string' ? payload.sound : null,
            audioState: typeof payload.audioState === 'string' ? payload.audioState : null,
            played: payload.played === true,
          }
          if (stats.lastAck.audioState !== null && stats.lastAck.audioState !== 'running') {
            stats.audioBlocked = stats.lastAck.played !== true
          } else if (stats.lastAck.played) {
            stats.audioBlocked = false
          }
          reply(res, 200, { ok: true })
        } catch {
          reply(res, 400, { ok: false, error: 'bad json' })
        }
      })
      return
    }

    reply(res, 404, { ok: false, error: `unknown route ${path}` })
  }

  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  ctx.effect(() => webServer.register({ kind: 'prefix', path: ROOT, handler: handle }), 'sound-notify: /sound-notify routes')
  log({ at: new Date().toISOString(), started: true, version: VERSION, pid: process.pid, config: cfg })
}
