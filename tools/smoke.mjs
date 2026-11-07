/**
 * Host-half smoke test for dsh-todo-queue.
 *
 * Loads lib/index.js against a stubbed Cordis context and a throwaway DSH_HOME,
 * then exercises apply(), the queue scheduler, serial dispatch, the two queue
 * families, review / send-back, the HTTP route, persistence, the tool and the
 * prompt section.
 *
 *   node tools/smoke.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dstq-smoke-'))
process.env.DSH_HOME = home

const mod = await import('../lib/index.js')

const registered = {
  tool: null,
  section: null,
  routes: [],
  listeners: [],
  effects: [],
}

const workspaceA = mkdtempSync(join(tmpdir(), 'dstq-ws-a-'))
const workspaceB = mkdtempSync(join(tmpdir(), 'dstq-ws-b-'))

// ------------------------------------------------------------------ stubs

const agentsById = new Map()
let agentSeq = 0

function makeAgent(options) {
  agentSeq += 1
  const cwd = options?.meta?.cwd ?? ''
  const agent = {
    id: options?.sessionId ?? 'session-stub-' + agentSeq,
    status: 'idle',
    session: { header: { id: options?.sessionId ?? 'session-stub-' + agentSeq, cwd } },
    sent: [],
    followup(message) {
      this.status = 'running'
      this.sent.push(message)
    },
    steer(message) {
      this.status = 'running'
      this.sent.push(message)
    },
  }
  agentsById.set(agent.id, agent)
  return agent
}

const agentsStub = {
  list: () => [...agentsById.values()],
  get: (id) => agentsById.get(id),
  async create(options) {
    const agent = makeAgent(options)
    if (typeof options.setup === 'function') await options.setup({})
    return { agent, dispose: async () => {} }
  },
}

const presetsStub = {
  async resolve() {
    return { id: 'standard' }
  },
  async mount() {
    return { id: 'standard' }
  },
}

const attached = []
const workspaces = new Map()
const workspaceStub = {
  async resolveByPath(path) {
    return workspaces.get(path)
  },
  async create(path) {
    const workspace = {
      id: 'ws-' + (workspaces.size + 1),
      path,
      async attachSession(sessionId) {
        attached.push({ path, sessionId })
      },
    }
    workspaces.set(path, workspace)
    return workspace
  },
}

const titles = new Map()
const sessionTitleStub = {
  get: (session) => titles.get(session?.header?.id ?? ''),
  rename: (session, title) => titles.set(session?.header?.id ?? '', title),
}

const logger = {
  calls: [],
  info: (...args) => logger.calls.push(['info', ...args]),
  warn: (...args) => logger.calls.push(['warn', ...args]),
  error: (...args) => logger.calls.push(['error', ...args]),
  debug: (...args) => logger.calls.push(['debug', ...args]),
}

const webServer = {
  register(route) {
    registered.routes.push(route)
    return () => {}
  },
}

function makeCtx() {
  const ctx = {
    root: undefined,
    webServer,
    get(key) {
      if (key === 'tools') {
        return {
          register(definition) {
            registered.tool = definition
            return () => {}
          },
        }
      }
      if (key === 'systemPrompt') {
        return {
          section(section) {
            registered.section = section
            return () => {}
          },
        }
      }
      if (key === 'agents') return agentsStub
      if (key === 'agentPresets') return presetsStub
      if (key === 'workspaceRegistry') return workspaceStub
      if (key === 'sessionTitle') return sessionTitleStub
      if (key === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) }
      }
      if (key === 'webServer') return webServer
      if (key === 'connection') return undefined
      return undefined
    },
    on(event, listener) {
      registered.listeners.push({ event, listener })
      return () => {}
    },
    effect(callback, label) {
      registered.effects.push(label)
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(names, callback) {
      callback(ctx)
    },
    logger,
  }
  return ctx
}

function fakeResponse() {
  const box = { status: 0, body: '' }
  return {
    box,
    writeHead(status) {
      box.status = status
    },
    end(body) {
      box.body = body === undefined ? '' : String(body)
    },
  }
}

const BROWSER_HEADERS = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }

async function postJson(payload) {
  const response = fakeResponse()
  const request = {
    method: 'POST',
    headers: BROWSER_HEADERS,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload), 'utf8')
    },
  }
  await apiRoute.handler(request, response)
  const body = response.box.body
  return body === '' ? { status: response.box.status } : JSON.parse(body)
}

async function getSnapshot(sessionId) {
  const response = fakeResponse()
  const query = sessionId ? '?session=' + encodeURIComponent(sessionId) : ''
  await apiRoute.handler({ method: 'GET', url: '/dsh-todo-queue/api' + query, headers: BROWSER_HEADERS }, response)
  return JSON.parse(response.box.body)
}

function listener(event) {
  return registered.listeners.filter((entry) => entry.event === event)
}

async function fireTurnEnd(agent) {
  agent.status = 'idle'
  for (const entry of listener('agent/turn-stopping')) {
    await entry.listener({ agent, turn: 1, signal: { aborted: false } })
  }
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** Force the scheduler synchronously instead of waiting for the 3s tick. */
async function pump() {
  await plugin.__tick()
  await new Promise((resolve) => setTimeout(resolve, 5))
}

// ------------------------------------------------------------------- apply

assert.equal(mod.name, 'dsh-todo-queue')
const plugin = mod.apply(makeCtx())

assert.equal(registered.tool?.name, 'todo_queue', 'todo_queue tool registered')
assert.equal(registered.tool.parameters.required[0], 'action')
assert.equal(registered.section?.name, 'todo-queue', 'prompt section registered')
assert.equal(registered.section.order, 150)
assert.ok(registered.section.text.includes('会话级'), 'prompt keeps the queue apart from session todo')
assert.ok(registered.tool.description.includes('会话级'), 'tool description carries the same boundary')
const apiRoute = registered.routes.find((route) => route.path === '/dsh-todo-queue/api')
assert.ok(apiRoute !== undefined, 'api route registered')
assert.equal(listener('agent/turn-stopping').length, 1, 'turn-stopping listener registered')
assert.ok(existsSync(plugin.boardPath) === false, 'board file is created by the first write, not load')
assert.ok(statSync(workspaceA).isDirectory())

// --------------------------------------------------------------- create

const createdA = await postJson({
  action: 'create',
  title: '工作区 A 的第一条',
  note: '验收：输出 A',
  queue: 'workspace',
  workspace: workspaceA,
})
assert.equal(createdA.ok, true, 'create accepted')
const todoA = createdA.todo
assert.equal(todoA.status, 'pending')
assert.ok(existsSync(plugin.boardPath), 'board file written after the first change')

await pump()
const board = plugin.__board()
assert.equal(board.todos.length, 1)
assert.equal(board.todos[0].status, 'running', 'queue auto-dispatched the first pending row')
const agentA = agentsById.get(board.todos[0].sessionId)
assert.ok(agentA !== undefined, 'a session was spawned')
assert.equal(agentA.session.header.cwd, workspaceA, 'session cwd is the row workspace')
assert.ok(agentA.sent.length === 1, 'the run prompt was sent')
assert.equal(agentA.sent[0].source.kind, 'plugin:dsh-todo-queue')
assert.ok(agentA.sent[0].content[0].text.includes('工作区 A 的第一条'), 'prompt carries the title')
assert.equal(titles.get(agentA.id), 'TODO·工作区 A 的第一条', 'session title is pinned')
assert.ok(attached.some((entry) => entry.sessionId === agentA.id), 'session attached to its workspace')

// ------------------------------------------------- same queue stays serial

const createdA2 = await postJson({
  action: 'create',
  title: '工作区 A 的第二条',
  queue: 'workspace',
  workspace: workspaceA,
})
assert.equal(createdA2.ok, true)
await pump()
assert.equal(plugin.__board().todos[1].status, 'pending', 'a busy queue does not start a second session')
assert.equal(agentsById.size, 1, 'still one spawned session for this workspace')

// The global queue is independent and may run in parallel.
const createdG = await postJson({
  action: 'create',
  title: '全局的一条',
  queue: 'global',
  workspace: workspaceA,
})
assert.equal(createdG.ok, true)
await pump()
assert.equal(plugin.__board().todos[2].status, 'running', 'global queue dispatches while a workspace queue is busy')
assert.equal(agentsById.size, 2, 'global queue has its own session')

// ------------------------------------------------------- review + send back

await fireTurnEnd(agentA)
assert.equal(plugin.__board().todos[0].status, 'review', 'turn end moves a run to review')
await pump()
assert.equal(plugin.__board().todos[1].status, 'running', 'the next row starts when the queue frees')
const agentA2 = agentsById.get(plugin.__board().todos[1].sessionId)
assert.ok(agentA2 !== undefined && agentA2.id !== agentA.id, 'the next row gets a fresh session')

const snapshot = await getSnapshot(agentA.id)
assert.equal(snapshot.sessionTodo?.id, todoA.id, 'the overlay can find its row by session id')
assert.equal(snapshot.sessionTodo?.status, 'review')

const sentBack = await postJson({
  action: 'sendBack',
  id: todoA.id,
  suggestion: '输出改成 B，并补一个测试',
})
assert.equal(sentBack.ok, true)
assert.equal(sentBack.todo.status, 'pending', 'send-back returns the row to the run queue')
assert.equal(sentBack.todo.feedback.length, 1)

// It waits behind the currently running row, then reuses its own live session
// with the new suggestion in the prompt.
await pump()
assert.equal(plugin.__board().todos[0].status, 'pending', 'send-back waits for the busy queue')
await fireTurnEnd(agentA2)
await pump()
const reused = plugin.__board().todos.find((todo) => todo.id === todoA.id)
assert.equal(reused.status, 'running', 'the returned row is dispatched again')
assert.equal(reused.sessionId, agentA.id, 'it reuses its own live session')
assert.ok(agentA.sent.length >= 2)
assert.ok(agentA.sent[agentA.sent.length - 1].content[0].text.includes('输出改成 B'))
assert.ok(agentA.sent[agentA.sent.length - 1].content[0].text.includes('补一个测试'))

const accepted = await postJson({ action: 'accept', id: todoA.id })
assert.equal(accepted.ok, false, 'a running row cannot be accepted')
await fireTurnEnd(agentA)
await pump()
const acceptedNow = await postJson({ action: 'accept', id: todoA.id })
assert.equal(acceptedNow.ok, true)
assert.equal(acceptedNow.todo.status, 'accepted')
assert.equal((await getSnapshot(agentA.id)).sessionTodo, null, 'the overlay disappears after acceptance')

// ------------------------------------------------------- global queue frees

await fireTurnEnd(agentsById.get(plugin.__board().todos[2].sessionId))
assert.equal(plugin.__board().todos[2].status, 'review')

// -------------------------------------------------------------- persistence

const onDisk = JSON.parse(readFileSync(plugin.boardPath, 'utf8'))
assert.equal(onDisk.version, 1)
assert.equal(onDisk.todos.length, 3)
assert.equal(onDisk.todos.find((todo) => todo.id === todoA.id).status, 'accepted')

// ------------------------------------------------------------------- tool

const listed = await registered.tool.execute({ action: 'list' }, { agent: agentA })
assert.ok(listed.message.includes('工作区 A 的第一条'))
assert.equal(listed.todos.length, 3)

const addedByTool = await registered.tool.execute(
  { action: 'add', title: '工具加的一条', queue: 'workspace', workspace: workspaceB, note: '验收：B' },
  { agent: agentA },
)
assert.ok(addedByTool.message.includes('已加入队列'))
assert.equal(plugin.__board().todos.length, 4)
await pump()
const toolTodo = plugin.__board().todos.find((todo) => todo.title === '工具加的一条')
assert.equal(toolTodo.status, 'running', 'tool-added rows enter the same queue')
assert.equal(toolTodo.workspace, workspaceB)

// A second workspace queue has its own single slot: create two and only one runs.
await postJson({ action: 'create', title: '工作区 B 的第二条', queue: 'workspace', workspace: workspaceB })
await pump()
const workspaceBRows = plugin.__board().todos.filter((todo) => todo.workspace === workspaceB)
assert.equal(workspaceBRows.filter((todo) => todo.status === 'running').length, 1, 'per-workspace serial')
assert.equal(workspaceBRows.filter((todo) => todo.status === 'pending').length, 1)

// ------------------------------------------------------------ approval gate

const gate = listener('tools/pre-execute')[0]
assert.ok(gate !== undefined, 'approval gate registered')
let allowed = false
const decision = gate.listener({ name: 'todo_queue', arguments: { action: 'add' } }, () => {
  allowed = true
  return { kind: 'allow' }
})
assert.equal(allowed, false)
assert.equal(decision.kind, 'ask')
let listAllowed = false
gate.listener({ name: 'todo_queue', arguments: { action: 'list' } }, () => {
  listAllowed = true
  return { kind: 'allow' }
})
assert.equal(listAllowed, true)

// --------------------------------------------------------------- teardown

for (const effect of registered.effects) {
  /* effects ran eagerly; their disposers are not retained by the stub */
}
rmSync(home, { recursive: true, force: true })
rmSync(workspaceA, { recursive: true, force: true })
rmSync(workspaceB, { recursive: true, force: true })

// ------------------------------------------------------ browser-half checks

const clientSource = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
assert.ok(clientSource.includes("name: 'main'"), 'client registers a main page')
assert.ok(clientSource.includes("key: PANEL_ID"), 'main page is keyed')
assert.ok(clientSource.includes("sidebar.panellist"), 'client adds a sidebar entry')
assert.ok(clientSource.includes("shell.overlay"), 'client adds the review overlay')
assert.ok(clientSource.includes('@media (max-width:640px)'), 'page has a mobile breakpoint')
assert.ok(clientSource.includes('@media (max-width:900px)'), 'page has a tablet breakpoint')
assert.ok(clientSource.includes('useSession'), 'overlay binds the current session')

console.log('smoke OK')
