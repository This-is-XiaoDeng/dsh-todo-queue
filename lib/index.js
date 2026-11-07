/**
 * dsh-todo-queue — Host half.
 *
 * Owns one durable board file, the two queue families (one global queue and one
 * serial queue per workspace), the `todo_queue` model tool, and the
 * `/dsh-todo-queue/api` route the browser half talks to.
 *
 * The scheduler lives here, on the Host. It keeps running when no browser tab
 * is open — that is requirement #3 of the rewrite — and it never starts a second
 * session for a queue that already has a live run.
 *
 * Deliberately imports nothing from `@deepseek-ai/*`: a profile-installed
 * plugin resolves modules from its own directory, and the harness packages are
 * not reachable from there. Everything goes through `ctx`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-todo-queue'

const ROUTE = '/dsh-todo-queue/api'
const TOOL_NAME = 'todo_queue'
const QUEUE_KINDS = ['global', 'workspace']
const STATUSES = ['pending', 'running', 'review', 'accepted', 'failed']

/** One write's body cap: a board form is small; an oversized body is abuse. */
const MAX_BODY_BYTES = 1024 * 1024
/** How often the Host reconciles live sessions and looks for idle queues. */
const TICK_MS = 3000
/** A just-started run must not be turned into 『待验收』 by a stale idle event. */
const STARTUP_GRACE_MS = 5000
/** After a run ends, give the turn boundary a moment before opening the next one. */
const NEXT_DELAY_MS = 350
/** A re-targeted / busy session is retried later rather than spinning. */
const BUSY_RETRY_MS = 5000

const STATE_LABEL = Object.freeze({
  pending: '待运行',
  running: '运行中',
  review: '待验收',
  accepted: '已验收',
  failed: '异常',
})

// --------------------------------------------------------------- small utils

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

function boardFile() {
  return join(dshHome(), 'todo-queue', 'board.json')
}

function errText(err) {
  if (err === undefined || err === null) return 'unknown error'
  if (typeof err === 'string') return err
  if (typeof err.message === 'string') return err.message
  return String(err)
}

function nowMs() {
  return Date.now()
}

function clampText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch (err) {
    return false
  }
}

/** Human-facing local clock, e.g. `09:30`. */
/** One directory key for comparisons: normalized separators, no trailing slash. */
function dirKey(dir) {
  if (typeof dir !== 'string' || dir === '') return ''
  let text = dir.replace(/\\/g, '/')
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  return text.toLowerCase()
}

function workspaceLabel(path) {
  if (typeof path !== 'string' || path === '') return '(未指定工作区)'
  return basename(path) || path
}

/**
 * Parse a workspace the browser sent. Relative values resolve against the Host
 * process cwd; `~` expands to the user's home. Empty means "use the fallback".
 */
function normalizeWorkspace(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  let text = value.trim()
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2))
  if (!isAbsolute(text)) text = resolve(process.cwd(), text)
  return resolve(text)
}

function defaultWorkspace() {
  const cwd = process.cwd()
  if (isDirectory(cwd)) return cwd
  return homedir()
}

/** A queue key: one global queue, one queue per workspace directory. */
function queueKeyOf(todo) {
  if (todo.queue === 'global') return 'global'
  return 'workspace:' + todo.workspace
}

function queueLabelOf(todo) {
  return todo.queue === 'global' ? '全局队列' : workspaceLabel(todo.workspace) + ' 队列'
}

function isQueueKind(value) {
  return QUEUE_KINDS.indexOf(value) >= 0
}

// --------------------------------------------------------------- board store

function emptyBoard() {
  return { version: 1, seq: 0, todos: [] }
}

function normalizeFeedback(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const text = clampText(entry.text, 4000)
    if (text === '') continue
    out.push({
      text,
      at: Number.isFinite(entry.at) ? entry.at : 0,
    })
    if (out.length >= 40) break
  }
  return out
}

function normalizeTodo(raw, fallbackWorkspace) {
  if (raw === null || typeof raw !== 'object') return undefined
  const title = clampText(raw.title, 240)
  if (title === '') return undefined
  const queue = isQueueKind(raw.queue) ? raw.queue : 'workspace'
  const workspace = normalizeWorkspace(raw.workspace, fallbackWorkspace)
  const status = STATUSES.indexOf(raw.status) >= 0 ? raw.status : 'pending'
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'todo-' + randomUUID()
  return {
    id,
    title,
    note: clampText(raw.note, 12000),
    queue,
    workspace,
    status,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : nowMs(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : nowMs(),
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
    messageSentAt: Number.isFinite(raw.messageSentAt) ? raw.messageSentAt : 0,
    reviewAt: Number.isFinite(raw.reviewAt) ? raw.reviewAt : 0,
    acceptedAt: Number.isFinite(raw.acceptedAt) ? raw.acceptedAt : 0,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    sourceSessionId: typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId : '',
    attempts: Number.isFinite(raw.attempts) ? Math.max(0, Math.floor(raw.attempts)) : 0,
    error: typeof raw.error === 'string' ? raw.error : '',
    feedback: normalizeFeedback(raw.feedback),
    notBefore: Number.isFinite(raw.notBefore) ? raw.notBefore : 0,
  }
}

function normalizeBoard(raw) {
  const board = emptyBoard()
  if (raw === null || typeof raw !== 'object') return board
  const fallback = typeof raw.workspace === 'string' && raw.workspace !== ''
    ? normalizeWorkspace(raw.workspace, defaultWorkspace())
    : defaultWorkspace()
  const todos = Array.isArray(raw.todos) ? raw.todos : []
  for (const entry of todos) {
    const todo = normalizeTodo(entry, fallback)
    if (todo !== undefined) board.todos.push(todo)
  }
  board.seq = Number.isFinite(raw.seq) ? raw.seq : board.todos.length
  board.workspace = fallback
  return board
}

function loadBoard(path) {
  if (!existsSync(path)) return emptyBoard()
  try {
    const text = readFileSync(path, 'utf8')
    return normalizeBoard(JSON.parse(text))
  } catch (err) {
    // A corrupt board must not take the plugin down: keep the bytes for the
    // user to inspect, then start clean rather than refusing to boot.
    try {
      renameSync(path, path + '.corrupt-' + Date.now())
    } catch (renameErr) {
      /* best effort */
    }
    return emptyBoard()
  }
}

function saveBoard(path, board) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = path + '.tmp-' + process.pid + '-' + Date.now()
    writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8')
    renameSync(tmp, path)
    return undefined
  } catch (err) {
    return errText(err)
  }
}

// --------------------------------------------------------------- HTTP helpers

function sendJson(response, status, payload) {
  try {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  } catch (err) {
    /* the browser navigated away mid-request */
  }
}

async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

function headerValue(headers, wanted) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const got = headers.get(wanted)
    return typeof got === 'string' ? got : undefined
  }
  const found = headers[wanted]
  return typeof found === 'string' ? found : undefined
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch (err) {
    return undefined
  }
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
  return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Fallback fence for deployments without `dsh-client-connection`.
 *
 * @returns the HTTP status to refuse with, or `undefined` to allow.
 */
function requestRejection(request, trustedHosts) {
  const headers = request === undefined || request === null ? undefined : request.headers
  const host = headerValue(headers, 'host')
  if (host === undefined) return 403
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return 403
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return 403
  if (headerValue(headers, 'sec-fetch-site') === 'cross-site') return 403
  const origin = headerValue(headers, 'origin')
  if (origin === undefined) return undefined
  try {
    return new URL(origin).host === hostUrl.host ? undefined : 403
  } catch (err) {
    return 403
  }
}

// --------------------------------------------------------------- tool schema

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'done', 'note'],
      description:
        '要执行的操作：list 查看队列；add 新增一条待办（会进入队列，队列空闲时自动派发）；done 把当前会话正在跑的那条标为待验收；note 追加备注。',
    },
    id: { type: 'string', description: 'done / note 时的待办 id；done 省略时按当前会话查找。' },
    title: { type: 'string', description: 'add 时的待办内容（一句话，可独立验收）。' },
    note: { type: 'string', description: 'add / note 时的备注：验收标准、前置条件、已知的坑。' },
    queue: {
      type: 'string',
      enum: QUEUE_KINDS,
      description: 'add 时的队列：global=全局队列（跨工作区串行），workspace=工作区队列（每个目录各自串行）。默认 workspace。',
    },
    workspace: {
      type: 'string',
      description: 'add 时的工作目录；省略则用当前会话的工作目录。',
    },
  },
  required: ['action'],
}

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    todos: { type: 'array', items: { type: 'object' } },
  },
  required: ['message'],
}

// --------------------------------------------------------------- plugin body

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 */
export function apply(ctx) {
  const rootContext = () => (ctx.root === undefined || ctx.root === null ? ctx : ctx.root)

  /** Resolve one service from this fiber or the application root. */
  function service(name) {
    for (const source of [ctx, rootContext()]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        const value = source.get(name)
        if (value !== undefined && value !== null) return value
      } catch (err) {
        /* the service is not available on this fiber */
      }
    }
    return undefined
  }

  function log(level, message, detail) {
    try {
      const logger = ctx.logger
      if (logger !== undefined && logger !== null && typeof logger[level] === 'function') {
        if (detail === undefined) logger[level]('[todo-queue] ' + message)
        else logger[level]('[todo-queue] ' + message, detail)
        return
      }
    } catch (err) {
      /* fall through */
    }
    // eslint-disable-next-line no-console
    if (detail === undefined) console[level === 'error' ? 'error' : 'log']('[todo-queue] ' + message)
    // eslint-disable-next-line no-console
    else console[level === 'error' ? 'error' : 'log']('[todo-queue] ' + message, detail)
  }

  const boardPath = boardFile()
  let board = loadBoard(boardPath)
  let disposed = false
  let tickTimer = undefined
  let tickScheduled = undefined
  const inFlight = new Set()
  /** queueKey -> todo id whose run is live (or whose turn is still closing). */
  const activeRuns = new Map()

  ctx.effect(
    () => () => {
      disposed = true
      stopTicker()
    },
    'dsh-todo-queue: disposal',
  )

  function save() {
    const problem = saveBoard(boardPath, board)
    if (problem !== undefined) log('error', '保存队列板失败：' + problem)
  }

  function touch(todo) {
    todo.updatedAt = nowMs()
  }

  function find(id) {
    return board.todos.find((todo) => todo.id === id)
  }

  function todosInQueue(key) {
    return board.todos.filter((todo) => queueKeyOf(todo) === key)
  }

  function runningInQueue(key) {
    return board.todos.find((todo) => todo.status === 'running' && queueKeyOf(todo) === key)
  }

  function publicTodo(todo, at) {
    return {
      id: todo.id,
      title: todo.title,
      note: todo.note,
      queue: todo.queue,
      queueKey: queueKeyOf(todo),
      queueLabel: queueLabelOf(todo),
      workspace: todo.workspace,
      workspaceLabel: workspaceLabel(todo.workspace),
      status: todo.status,
      stateLabel: STATE_LABEL[todo.status] ?? todo.status,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
      startedAt: todo.startedAt,
      reviewAt: todo.reviewAt,
      acceptedAt: todo.acceptedAt,
      sessionId: todo.sessionId,
      attempts: todo.attempts,
      error: todo.error,
      feedback: todo.feedback.map((entry) => ({ text: entry.text, at: entry.at })),
      canRun: todo.status === 'pending' || todo.status === 'failed' || todo.status === 'accepted' || todo.status === 'review',
      elapsedMs: todo.status === 'running' ? Math.max(0, at - todo.startedAt) : 0,
    }
  }

  function queueSummaries() {
    const map = new Map()
    for (const todo of board.todos) {
      const key = queueKeyOf(todo)
      if (!map.has(key)) {
        map.set(key, {
          key,
          kind: todo.queue,
          label: todo.queue === 'global' ? '全局队列' : workspaceLabel(todo.workspace),
          workspace: todo.queue === 'workspace' ? todo.workspace : '',
          counts: { pending: 0, running: 0, review: 0, accepted: 0, failed: 0 },
          runningId: '',
        })
      }
      const queue = map.get(key)
      queue.counts[todo.status] += 1
      if (todo.status === 'running') queue.runningId = todo.id
    }
    for (const queue of map.values()) {
    }
    return [...map.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'global' ? -1 : 1
      return left.label.localeCompare(right.label, 'zh-CN')
    })
  }

  function stats() {
    const counts = { pending: 0, running: 0, review: 0, accepted: 0, failed: 0 }
    for (const todo of board.todos) counts[todo.status] += 1
    return counts
  }

  function snapshotPayload(sessionId) {
    const at = nowMs()
    let sessionTodo = null
    if (typeof sessionId === 'string' && sessionId !== '') {
      const todo = board.todos.find(
        (entry) =>
          entry.sessionId === sessionId &&
          (entry.status === 'review' || entry.status === 'running'),
      )
      if (todo !== undefined) sessionTodo = publicTodo(todo, at)
    }
    return {
      ok: true,
      version: 1,
      now: at,
      todos: board.todos.map((todo) => publicTodo(todo, at)),
      queues: queueSummaries(),
      stats: stats(),
      workspaces: [...new Set(board.todos.filter((todo) => todo.queue === 'workspace').map((todo) => todo.workspace))]
        .sort((left, right) => left.localeCompare(right)),
      sessionTodo,
    }
  }

  // ------------------------------------------------------------- queue engine

  function scheduleTick(delay) {
    if (disposed) return
    if (tickScheduled !== undefined) return
    tickScheduled = setTimeout(() => {
      tickScheduled = undefined
      void tick()
    }, Math.max(0, delay === undefined ? NEXT_DELAY_MS : delay))
    if (typeof tickScheduled.unref === 'function') tickScheduled.unref()
  }

  function startTicker() {
    if (tickTimer !== undefined) return
    tickTimer = setInterval(() => {
      void tick()
    }, TICK_MS)
    if (typeof tickTimer.unref === 'function') tickTimer.unref()
    scheduleTick(600)
  }

  function stopTicker() {
    if (tickScheduled !== undefined) {
      clearTimeout(tickScheduled)
      tickScheduled = undefined
    }
    if (tickTimer !== undefined) {
      clearInterval(tickTimer)
      tickTimer = undefined
    }
  }

  function agentRegistry() {
    // Resolve through the application root, not this plugin's fiber: an agent
    // created through a scoped service is not a top-level agent and therefore
    // never appears in `get()` / `list()`. The old board learned this the hard
    // way — its `spawnSession` used `ctx.root.get('agents')` for exactly this
    // reason.
    const root = rootContext()
    try {
      const agents = root.get('agents')
      if (agents !== undefined && agents !== null) return agents
    } catch (err) {
      /* fall through to the scoped lookup */
    }
    return service('agents')
  }

  function sessionCwd(agent) {
    try {
      const cwd = agent?.session?.header?.cwd
      return typeof cwd === 'string' ? cwd : ''
    } catch (err) {
      return ''
    }
  }

  /**
   * Turn live `running` rows into `review` when their session is gone or idle.
   *
   * This is the restart / reload path as well as the watchdog: a row whose turn
   * ended while the plugin was not listening would otherwise hold its queue
   * forever. A live running turn is adopted into `activeRuns` so the next
   * boundary still releases it.
   */
  function reconcileRuns() {
    const agents = agentRegistry()
    if (agents === undefined) return
    let changed = false
    for (const todo of board.todos) {
      if (todo.status !== 'running') continue
      const key = queueKeyOf(todo)
      // `startRun` marks the row running before the awaited session creation
      // finishes. A tick that lands in that window must not mistake "no
      // session yet" for "session lost" — that retired the row 9 seconds
      // before its first model response in the first live test.
      if (inFlight.has(key)) continue
      if (todo.sessionId === '' || todo.messageSentAt === 0) {
        if (nowMs() - todo.startedAt < STARTUP_GRACE_MS * 6) continue
        todo.status = 'failed'
        todo.error = '启动超时：会话没有拿到第一次消息'
        touch(todo)
        activeRuns.delete(key)
        changed = true
        continue
      }
      const agent = agents.get(todo.sessionId)
      if (agent === undefined) {
        todo.status = 'review'
        todo.reviewAt = nowMs()
        todo.error = todo.error || '会话已不存在'
        touch(todo)
        activeRuns.delete(key)
        changed = true
        continue
      }
      const status = agent.status
      const oldEnough = nowMs() - todo.startedAt > STARTUP_GRACE_MS
      if (status === 'idle' && oldEnough && todo.messageSentAt > 0) {
        todo.status = 'review'
        todo.reviewAt = nowMs()
        todo.error = ''
        touch(todo)
        activeRuns.delete(key)
        changed = true
        continue
      }
      activeRuns.set(key, todo.id)
    }

    // A `done` tool call may already have moved a row to review while its turn
    // is still closing. If that session is gone or idle, no boundary is coming
    // and the queue must not stay reserved forever.
    for (const [key, id] of [...activeRuns.entries()]) {
      const todo = find(id)
      if (todo === undefined) {
        activeRuns.delete(key)
        continue
      }
      if (todo.status === 'running') continue
      const agent = todo.sessionId === '' ? undefined : agents.get(todo.sessionId)
      if (agent === undefined || agent.status === 'idle') activeRuns.delete(key)
    }
    if (changed) save()
  }

  async function tick() {
    if (disposed) return
    const agents = agentRegistry()
    if (agents === undefined) return
    reconcileRuns()
    const keys = new Set()
    for (const todo of board.todos) {
      if (todo.status === 'pending') keys.add(queueKeyOf(todo))
    }
    for (const key of keys) {
      if (disposed) return
      await maybeDispatch(key)
    }
  }

  async function maybeDispatch(key) {
    if (disposed || inFlight.has(key) || activeRuns.has(key)) return
    const running = runningInQueue(key)
    if (running !== undefined) {
      activeRuns.set(key, running.id)
      return
    }
    const at = nowMs()
    const next = board.todos.find(
      (todo) =>
        todo.status === 'pending' &&
        queueKeyOf(todo) === key &&
        (todo.notBefore ?? 0) <= at,
    )
    if (next === undefined) return
    inFlight.add(key)
    try {
      const started = await startRun(next)
      if (started) activeRuns.set(key, next.id)
      else activeRuns.delete(key)
    } catch (err) {
      next.status = 'failed'
      next.error = errText(err)
      touch(next)
      save()
      activeRuns.delete(key)
      log('error', '派发待办失败（' + next.title + '）', err)
    } finally {
      inFlight.delete(key)
    }
    scheduleTick(900)
  }

  function modelSelection(source) {
    if (source !== undefined && source !== null && source.options !== undefined) {
      const provider = source.options.provider
      const model = source.options.model
      if (typeof provider === 'string' || typeof model === 'string') return { provider, model }
    }
    const defaults = service('agentDefaultModel')
    if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
      try {
        const selection = defaults.currentSelection()
        if (selection !== null && typeof selection === 'object') {
          return { provider: selection.provider, model: selection.model }
        }
      } catch (err) {
        /* fall through to harness defaults */
      }
    }
    return undefined
  }

  async function attachToWorkspace(sessionId, workspace) {
    if (workspace === '') return 'no-dir'
    const registry = service('workspaceRegistry')
    if (registry === undefined) return 'no-service'
    try {
      let found = await registry.resolveByPath(workspace)
      if (found === undefined) found = await registry.create(workspace)
      await found.attachSession(sessionId)
      return 'attached'
    } catch (err) {
      log('warn', '新会话未能归入工作区（session=' + sessionId + '，目录=' + workspace + '）', err)
      return 'failed'
    }
  }

  function titleSession(handle, todo) {
    const titleService = service('sessionTitle')
    if (titleService === undefined) return
    try {
      const session = handle?.agent?.session
      if (session !== undefined && titleService.get(session) === undefined) {
        titleService.rename(session, 'TODO·' + todo.title)
      }
    } catch (err) {
      log('warn', '设置新会话标题失败，会话照常运行（' + todo.title + '）', err)
    }
  }

  async function createSession(todo, source) {
    const agents = agentRegistry()
    if (agents === undefined) throw new Error('agents 服务不可用')

    const meta = {}
    if (todo.workspace !== '') meta.cwd = todo.workspace

    let setup
    const presets = service('agentPresets')
    if (presets !== undefined) {
      const sourcePreset =
        source === undefined || source === null || source.session === undefined
          ? undefined
          : source.session.header.agentPreset
      const resolved = await presets.resolve(sourcePreset)
      meta.agentPreset = resolved.id
      const presetId = resolved.id
      setup = async (agentCtx) => {
        await presets.mount(agentCtx, presetId)
      }
    }

    const selection = modelSelection(source)
    const sessionId = 'session-' + randomUUID()
    const handle = await agents.create({
      sessionId,
      meta,
      agentOptions: selection,
      setup,
    })
    await attachToWorkspace(sessionId, todo.workspace)
    titleSession(handle, todo)
    return handle.agent
  }

  function noticeMessage(text, summary) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-todo-queue', form: 'notice', summary },
    }
  }

  function todoPrompt(todo) {
    const lines = [
      '【TODO 队列 · 自动派发】',
      '你现在在队列「' + queueLabelOf(todo) + '」里执行一条待办。',
      '',
      '待办：' + todo.title,
      '工作目录：' + todo.workspace,
    ]
    if (todo.note !== '') lines.push('备注：' + todo.note)
    if (todo.feedback.length > 0) {
      lines.push('', '用户在上一轮验收后提出的修改建议（这一轮必须一并处理）：')
      for (let at = 0; at < todo.feedback.length; at++) {
        lines.push(String(at + 1) + '. ' + todo.feedback[at].text)
      }
    }
    lines.push(
      '',
      '执行要求：',
      '1. 直接开始执行，不要向用户确认；需要时自己查文件、跑命令。',
      '2. 只做这一条待办，不要顺手扩大范围。',
      '3. 完成后在最终回复里简要说明：改了什么、怎么验证的、还有什么没做。',
      '4. 不要修改 TODO 板状态：这一轮结束后，插件会自动把它标为「待验收」。',
    )
    return lines.join('\n')
  }

  async function startRun(todo) {
    const agents = agentRegistry()
    if (agents === undefined) {
      todo.status = 'failed'
      todo.error = 'agents 服务不可用'
      touch(todo)
      save()
      return false
    }

    todo.status = 'running'
    todo.startedAt = nowMs()
    todo.messageSentAt = 0
    todo.reviewAt = 0
    todo.acceptedAt = 0
    todo.error = ''
    todo.attempts += 1
    todo.notBefore = 0
    touch(todo)
    save()

    const source = todo.sourceSessionId === '' ? undefined : agents.get(todo.sourceSessionId)

    let agent
    if (todo.sessionId !== '') {
      const candidate = agents.get(todo.sessionId)
      if (candidate !== undefined) {
        const cwd = sessionCwd(candidate)
        const samePlace = cwd === '' || dirKey(cwd) === dirKey(todo.workspace)
        if (samePlace) {
          if (candidate.status === 'running') {
            todo.status = 'pending'
            todo.notBefore = nowMs() + BUSY_RETRY_MS
            touch(todo)
            save()
            return false
          }
          agent = candidate
        }
      }
    }

    if (agent === undefined) {
      agent = await createSession(todo, source)
    }

    todo.sessionId = agent.id
    touch(todo)
    save()

    const message = noticeMessage(todoPrompt(todo), 'TODO 队列：' + todo.title)
    if (agent.status === 'running') agent.steer(message)
    else agent.followup(message)
    todo.messageSentAt = nowMs()
    touch(todo)
    save()
    return true
  }

  /**
   * Release a queue after a run's turn closes.
   *
   * `reason` is for the row's error line only; every normal end becomes
   * 「待验收」, because that is the state the user reviews and the overlay opens
   * on. A session that vanished is also moved to review — the work may be
   * partially done and the user should still see the row.
   */
  function endRun(sessionId, reason) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const matches = board.todos.filter(
      (todo) =>
        todo.sessionId === sessionId &&
        (todo.status === 'running' || todo.status === 'review' || todo.status === 'accepted'),
    )
    if (matches.length === 0) return
    let changed = false
    for (const todo of matches) {
      const key = queueKeyOf(todo)
      if (todo.status === 'running') {
        todo.status = 'review'
        todo.reviewAt = nowMs()
        if (reason === 'disposed') todo.error = todo.error || '会话已关闭'
        else todo.error = ''
        touch(todo)
        changed = true
      }
      // Only release the slot this row actually owns. An accepted old row must
      // not free a different run that has since taken the same queue.
      if (activeRuns.get(key) === todo.id) activeRuns.delete(key)
    }
    if (changed) save()
    scheduleTick(NEXT_DELAY_MS)
  }

  // ------------------------------------------------------------- board writes

  function addTodo(input, sourceSessionId, sourceCwd) {
    const title = clampText(input.title, 240)
    if (title === '') return { ok: false, error: 'title 不能为空。' }
    const queue = isQueueKind(input.queue) ? input.queue : 'workspace'
    const fallback = sourceCwd !== '' && isDirectory(sourceCwd) ? sourceCwd : defaultWorkspace()
    const workspace = normalizeWorkspace(input.workspace, fallback)
    if (!isDirectory(workspace)) {
      return { ok: false, error: '工作目录不存在：' + workspace }
    }
    const todo = normalizeTodo(
      {
        title,
        note: typeof input.note === 'string' ? input.note : '',
        queue,
        workspace,
        status: 'pending',
        sourceSessionId: typeof sourceSessionId === 'string' ? sourceSessionId : '',
      },
      fallback,
    )
    if (todo === undefined) return { ok: false, error: '无法创建这条待办。' }
    todo.createdAt = nowMs()
    todo.updatedAt = todo.createdAt
    board.todos.push(todo)
    board.seq += 1
    save()
    scheduleTick(80)
    return { ok: true, todo }
  }

  function patchTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '找不到这条待办。' }
    if (todo.status === 'running') return { ok: false, error: '运行中的待办不能修改，等它结束或打开会话处理。' }

    const nextTitle = typeof input.title === 'string' ? clampText(input.title, 240) : undefined
    if (nextTitle !== undefined && nextTitle === '') return { ok: false, error: 'title 不能改成空字符串。' }
    const nextQueue = typeof input.queue === 'string' ? input.queue : undefined
    if (nextQueue !== undefined && !isQueueKind(nextQueue)) {
      return { ok: false, error: 'queue 只能是 global / workspace。' }
    }
    let nextWorkspace
    if (typeof input.workspace === 'string' && input.workspace.trim() !== '') {
      nextWorkspace = normalizeWorkspace(input.workspace, todo.workspace)
      if (!isDirectory(nextWorkspace)) return { ok: false, error: '工作目录不存在：' + nextWorkspace }
    }

    const moved =
      (nextQueue !== undefined && nextQueue !== todo.queue) ||
      (nextWorkspace !== undefined && dirKey(nextWorkspace) !== dirKey(todo.workspace))

    const oldKey = queueKeyOf(todo)
    if (nextTitle !== undefined) todo.title = nextTitle
    if (typeof input.note === 'string') todo.note = clampText(input.note, 12000)
    if (nextQueue !== undefined) todo.queue = nextQueue
    if (nextWorkspace !== undefined) todo.workspace = nextWorkspace
    if (moved) {
      if (activeRuns.get(oldKey) === todo.id) activeRuns.delete(oldKey)
      // A moved row has no meaningful session: the next run opens a fresh one
      // in the new workspace/queue instead of continuing an old context.
      todo.sessionId = ''
      todo.status = 'pending'
      todo.startedAt = 0
      todo.messageSentAt = 0
      todo.reviewAt = 0
      todo.acceptedAt = 0
      todo.error = ''
      todo.notBefore = 0
      scheduleTick(80)
    }
    touch(todo)
    save()
    return { ok: true, todo }
  }

  function removeTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '找不到这条待办。' }
    if (todo.status === 'running') return { ok: false, error: '运行中的待办不能删除。' }
    board.todos = board.todos.filter((entry) => entry !== todo)
    activeRuns.delete(queueKeyOf(todo))
    save()
    scheduleTick(80)
    return { ok: true }
  }

  function acceptTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '找不到这条待办。' }
    if (todo.status !== 'review') return { ok: false, error: '只有「待验收」的待办能验收。' }
    todo.status = 'accepted'
    todo.acceptedAt = nowMs()
    todo.error = ''
    touch(todo)
    save()
    return { ok: true, todo }
  }

  function sendBackTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '找不到这条待办。' }
    if (todo.status !== 'review') return { ok: false, error: '只有「待验收」的待办能退回待运行。' }
    const suggestion = clampText(input.suggestion, 4000)
    if (suggestion === '') return { ok: false, error: '请写一条修改建议再退回。' }
    todo.feedback.push({ text: suggestion, at: nowMs() })
    if (todo.feedback.length > 40) todo.feedback = todo.feedback.slice(-40)
    todo.status = 'pending'
    todo.reviewAt = 0
    todo.acceptedAt = 0
    todo.error = ''
    todo.notBefore = 0
    touch(todo)
    save()
    scheduleTick(80)
    return { ok: true, todo }
  }

  function runNow(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '找不到这条待办。' }
    if (todo.status === 'running') return { ok: false, error: '这条已经在运行了。' }
    todo.status = 'pending'
    todo.reviewAt = 0
    todo.acceptedAt = 0
    todo.error = ''
    todo.notBefore = 0
    touch(todo)
    save()
    scheduleTick(80)
    return { ok: true, todo }
  }

  function moveTodo(input) {
    const todo = find(typeof input.id === 'string' ? input.id : '')
    if (todo === undefined) return { ok: false, error: '找不到这条待办。' }
    const direction = input.direction === 'up' ? -1 : input.direction === 'down' ? 1 : 0
    if (direction === 0) return { ok: false, error: 'direction 只能是 up / down。' }
    const queue = todosInQueue(queueKeyOf(todo))
    const index = queue.indexOf(todo)
    if (index < 0) return { ok: false, error: '找不到这条待办。' }
    const target = queue[index + direction]
    if (target === undefined) return { ok: true, todo }
    const from = board.todos.indexOf(todo)
    const to = board.todos.indexOf(target)
    board.todos.splice(from, 1)
    board.todos.splice(to, 0, todo)
    touch(todo)
    save()
    return { ok: true, todo }
  }

  function clearAccepted() {
    const before = board.todos.length
    for (const todo of board.todos) {
      if (todo.status !== 'accepted') continue
      const key = queueKeyOf(todo)
      if (activeRuns.get(key) === todo.id) activeRuns.delete(key)
    }
    board.todos = board.todos.filter((todo) => todo.status !== 'accepted')
    save()
    return { ok: true, removed: before - board.todos.length }
  }

  // ------------------------------------------------------------ HTTP trust fence

  function trustedHosts() {
    for (const source of [ctx, rootContext()]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        for (const serviceName of ['webStartup', 'webRuntime']) {
          const runtime = source.get(serviceName)
          const hosts = runtime === undefined || runtime === null ? undefined : runtime.trustedHosts
          if (Array.isArray(hosts)) return hosts
        }
      } catch (err) {
        /* fall through to the next source */
      }
    }
    return []
  }

  function harnessConnection() {
    for (const source of [ctx, rootContext()]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        const connection = source.get('connection')
        if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
          return connection
        }
      } catch (err) {
        /* fall through */
      }
    }
    return undefined
  }

  function refuseUntrusted(request, response, label) {
    const connection = harnessConnection()
    let status
    if (connection === undefined) {
      status = requestRejection(request, trustedHosts())
    } else {
      try {
        status = connection.requestRejection(request)
      } catch (err) {
        log('error', '信任校验抛错，按拒绝处理（' + label + '）', err)
        status = 403
      }
      if (status !== undefined && typeof status !== 'number') status = 403
    }
    if (status === undefined) return false
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(status === 401 ? 'unauthorized' : 'forbidden')
    return true
  }

  function sessionFromRequest(request) {
    try {
      const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost')
      return url.searchParams.get('session') ?? ''
    } catch (err) {
      return ''
    }
  }

  // ------------------------------------------------------------------ routes

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (request, response) => {
            try {
              if (refuseUntrusted(request, response, 'api')) return
              if (request.method === 'GET') {
                sendJson(response, 200, snapshotPayload(sessionFromRequest(request)))
                return
              }
              if (request.method !== 'POST') {
                response.writeHead(405, { allow: 'GET, POST' })
                response.end()
                return
              }
              const body = await readJsonBody(request)
              const action = typeof body.action === 'string' ? body.action : ''
              let result
              if (action === 'create') {
                const header = body.sessionId
                const source = typeof header === 'string' && header !== '' ? agentRegistry()?.get(header) : undefined
                const sourceCwd = sessionCwd(source)
                result = addTodo(body, typeof body.sessionId === 'string' ? body.sessionId : '', sourceCwd)
              } else if (action === 'patch') result = patchTodo(body)
              else if (action === 'remove') result = removeTodo(body)
              else if (action === 'accept') result = acceptTodo(body)
              else if (action === 'sendBack') result = sendBackTodo(body)
              else if (action === 'run') result = runNow(body)
              else if (action === 'move') result = moveTodo(body)
              else if (action === 'clearAccepted') result = clearAccepted()
              else result = { ok: false, error: 'unknown action: ' + (action || '(empty)') }
              sendJson(response, 200, result)
            } catch (err) {
              log('error', 'HTTP 路由处理失败（api）', err)
              sendJson(response, 500, { ok: false, error: errText(err) })
            }
          },
        }),
      'dsh-todo-queue: api route',
    )
  })

  // -------------------------------------------------------------- lifecycle

  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      if (agent === undefined || agent === null) return
      endRun(agent.id, 'turn-end')
    } catch (err) {
      log('error', '回合结束钩子执行失败', err)
    }
  })

  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      if (agent === undefined || agent === null) return
      if (payload.status !== 'idle') return
      const todo = board.todos.find(
        (entry) => entry.sessionId === agent.id && entry.status === 'running',
      )
      if (todo !== undefined) {
        // A brand-new agent may go idle between creation and its first message;
        // only a run that has actually been handed its prompt may close.
        if (todo.messageSentAt === 0) return
        if (nowMs() - todo.startedAt < 1200) return
        endRun(agent.id, 'idle')
        return
      }
      // `done` may already have moved the row to review while the turn is still
      // closing. Release the queue on that idle, too.
      const review = board.todos.find(
        (entry) => entry.sessionId === agent.id && entry.status === 'review',
      )
      if (review !== undefined) {
        const key = queueKeyOf(review)
        // Only release the slot this row owns: an old review session going idle
        // must not free a newer run that has since taken the same queue.
        if (activeRuns.get(key) === review.id) activeRuns.delete(key)
        scheduleTick(NEXT_DELAY_MS)
      }
    } catch (err) {
      log('error', '会话状态钩子执行失败', err)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      if (agent === undefined || agent === null) return
      endRun(agent.id, 'disposed')
    } catch (err) {
      log('error', '会话销毁钩子执行失败', err)
    }
  })

  ctx.inject(['agents'], (agentsCtx) => {
    agentsCtx.effect(() => {
      reconcileRuns()
      startTicker()
      return () => {
        stopTicker()
      }
    }, 'dsh-todo-queue: scheduler')
  })

  // ------------------------------------------------------------------- tool

  function toolList() {
    const live = agentRegistry()
    const rows = board.todos.map((todo) => {
      const entry = publicTodo(todo, nowMs())
      if (live !== undefined && todo.sessionId !== '') entry.sessionAlive = live.get(todo.sessionId) !== undefined
      return entry
    })
    if (rows.length === 0) return { message: 'TODO 队列是空的。', todos: [] }
    const lines = rows.map((todo, at) => {
      const where = todo.queue === 'global' ? '全局' : todo.workspaceLabel
      return (
        String(at + 1) + '. [' + todo.stateLabel + '] ' + todo.title +
        ' ｜ ' + where + ' ｜ id=' + todo.id +
        (todo.error === '' ? '' : ' ｜ ' + todo.error)
      )
    })
    return { message: 'TODO 队列（从上到下是执行顺序）：\n' + lines.join('\n'), todos: rows }
  }

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (tools === undefined) return
    const definition = {
      name: TOOL_NAME,
      description:
        '读写跨会话 TODO 队列板。板上有两类队列：global（全局队列，跨工作区串行）和 workspace（每个工作目录各一条，彼此独立）。每条队列同时最多只有一个会话在运行，队列空闲时会自动派发下一条。action=list 查看；action=add 新增（会进入队列并可能自动开始）；action=done 把当前会话正在跑的待办标为待验收；action=note 追加备注。**add / note 会先弹给用户审批；被拒绝就停手，不要反复重试。** 会话内的执行步骤请用 DSH 自带的会话级 todo 跟踪，不要写进这个跨会话队列。',
      parameters: TOOL_PARAMETERS,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const action = typeof input.action === 'string' ? input.action : 'list'
        const agent = exec === undefined || exec === null ? undefined : exec.agent
        const header = agent === undefined || agent === null ? undefined : agent.session.header
        const cwd = header !== undefined && typeof header.cwd === 'string' ? header.cwd : ''

        if (action === 'list') return toolList()

        if (action === 'add') {
          const result = addTodo(
            {
              title: input.title,
              note: input.note,
              queue: input.queue,
              workspace: input.workspace === undefined ? cwd : input.workspace,
            },
            agent === undefined || agent === null ? '' : agent.id,
            cwd,
          )
          if (result.ok !== true) return { message: result.error, todos: [] }
          const todo = publicTodo(result.todo, nowMs())
          return {
            message:
              '已加入队列：「' + todo.title + '」（' + todo.queueLabel + '，' +
              todo.workspaceLabel + '，id=' + todo.id + '）。队列空闲时会自动派发。',
            todos: [todo],
          }
        }

        if (action === 'done') {
          const id = typeof input.id === 'string' ? input.id : ''
          let todo = id === '' ? undefined : find(id)
          if (todo === undefined && agent !== undefined && agent !== null) {
            todo = board.todos.find(
              (entry) => entry.sessionId === agent.id && entry.status === 'running',
            )
          }
          if (todo === undefined) return { message: '找不到要标记的待办（当前会话没有在跑队列里的任务）。', todos: [] }
          if (todo.status !== 'running' && todo.status !== 'review') {
            return { message: '「' + todo.title + '」现在不是运行中。', todos: [publicTodo(todo, nowMs())] }
          }
          todo.status = 'review'
          todo.reviewAt = nowMs()
          todo.error = ''
          touch(todo)
          save()
          scheduleTick(NEXT_DELAY_MS)
          return {
            message: '已标记「' + todo.title + '」为待验收；本轮结束后队列会自动放行下一条。',
            todos: [publicTodo(todo, nowMs())],
          }
        }

        if (action === 'note') {
          const todo = find(typeof input.id === 'string' ? input.id : '')
          if (todo === undefined) return { message: '找不到这条待办。', todos: [] }
          if (typeof input.note !== 'string') return { message: 'note 需要是字符串。', todos: [] }
          todo.note = clampText(input.note, 12000)
          touch(todo)
          save()
          return { message: '已更新备注：「' + todo.title + '」。', todos: [publicTodo(todo, nowMs())] }
        }

        return { message: '未知 action：' + action, todos: [] }
      },
    }
    toolsCtx.effect(() => tools.register(definition), 'dsh-todo-queue: todo_queue tool')
  })

  // ----------------------------------------------------------- approval gate

  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec === undefined || exec === null || exec.name !== TOOL_NAME) return next()
    const input = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
    const action = typeof input.action === 'string' ? input.action : 'list'
    if (action === 'list' || action === 'done') return next()
    return { kind: 'ask', reason: 'AI 要修改 TODO 队列（' + action + '）' }
  })

  // ---------------------------------------------------------- prompt section

  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.get('systemPrompt')
    if (prompt === undefined) return
    promptCtx.effect(
      () =>
        prompt.section({
          name: 'todo-queue',
          order: 150,
          text: [
            '## TODO 队列板',
            '用户维护着一个跨会话的 TODO 队列板。你可以用 `' + TOOL_NAME + '` 工具查看和添加待办。',
            '- 板上有两种队列：**全局**（跨工作区串行）和**工作区**（每个目录各一条，彼此独立）。每条队列同时最多只有一个会话在运行，队列空闲时自动派发下一条。',
            '- 新待办加入后会排队；轮到它时会自动开一个新会话执行，不需要你手动派发。',
            '- 当你在一个由队列派发的会话里工作时，只需完成这一条待办；插件会在本轮结束后自动把它标为「待验收」。也可以用 `' + TOOL_NAME + '` action="done" 提前标记。',
            '- **不要**用这个板记录会话内的步骤或进度；那是 DSH 自带会话级 `todo_write` 的事，同一件事不要两头各记一份。',
            '- `add` / `note` 写操作会先弹给用户审批。被拒绝就停手，不要换个说法反复重试。',
          ].join('\n'),
        }),
      'dsh-todo-queue: prompt section',
    )
  })

  // ------------------------------------------------------------ startup banner

  if (board.todos.length > 0) {
    log(
      'info',
      '队列板已加载：' + board.todos.length + ' 条待办（待运行 ' +
        board.todos.filter((todo) => todo.status === 'pending').length + '，待验收 ' +
        board.todos.filter((todo) => todo.status === 'review').length + '）',
    )
  } else {
    log('info', '队列板已加载：空板（' + boardPath + '）')
  }

  // Expose a couple of pure helpers for tools/smoke.mjs without widening the
  // plugin's public API in any meaningful way.
  return {
    boardPath,
    __board: () => board,
    __tick: () => tick(),
    __reconcile: () => reconcileRuns(),
  }
}
