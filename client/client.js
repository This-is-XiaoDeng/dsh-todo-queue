window.__ModuleLoader__.load({
  id: 'dsh-todo-queue',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    const React = require('react')
    const h = React.createElement

    const ROUTE = '/dsh-todo-queue/api'
    const PANEL_ID = 'todo-queue'
    const POLL_MS = 2000
    const STATUS_LABEL = {
      pending: '待运行',
      running: '运行中',
      review: '待验收',
      accepted: '已验收',
      failed: '异常',
    }
    const STATUS_CLASS = {
      pending: 'idle',
      running: 'run',
      review: 'review',
      accepted: 'ok',
      failed: 'bad',
    }

    // ---------------------------------------------------------------- helpers

    const errText = (err) => {
      if (err === null || err === undefined) return 'unknown error'
      if (typeof err === 'string') return err
      if (typeof err.message === 'string') return err.message
      return String(err)
    }

    async function request(url, options) {
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
      })
      const text = await response.text()
      let data
      try {
        data = text === '' ? {} : JSON.parse(text)
      } catch (err) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? '没有权限访问队列板：请用 dsh web 打印的带 token 地址重新打开页面。'
            : text.slice(0, 240) || 'HTTP ' + response.status,
        )
      }
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      if (data.ok === false) throw new Error(data.error || '操作失败')
      return data
    }

    const snapshotUrl = (sessionId) =>
      ROUTE + (sessionId ? '?session=' + encodeURIComponent(sessionId) : '')

    const post = (action, payload) =>
      request(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(payload || {}) }),
      })

    const formatClock = (ms) => {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function useActivePanel(usePanelInfo) {
      // `activePanelId` is `null` when the Conversation is showing; a panel id
      // means some global page (Plugins, TODO, …) is covering it.
      return usePanelInfo((info) => (info === undefined || info === null ? null : info.activePanelId ?? null))
    }

    function useSnapshot(sessionId) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState('')
      const alive = React.useRef(true)
      const generation = React.useRef(0)
      const load = React.useCallback(async () => {
        const at = generation.current
        try {
          const data = await request(snapshotUrl(sessionId), { method: 'GET' })
          if (alive.current && generation.current === at) {
            setSnapshot(data)
            setError('')
          }
          return data
        } catch (err) {
          if (alive.current && generation.current === at) setError(errText(err))
          return null
        }
      }, [sessionId])
      React.useEffect(() => {
        const id = ++generation.current
        alive.current = true
        let timer
        const tick = async () => {
          await load()
          if (alive.current && generation.current === id) timer = setTimeout(tick, POLL_MS)
        }
        void tick()
        return () => {
          alive.current = false
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [load])
      return { snapshot, error, refresh: load }
    }

    function useCurrentSession(useSessions) {
      return useSessions((state) => {
        const byId = state === undefined || state === null ? undefined : state.byId
        if (byId === undefined || byId === null) return undefined
        for (const row of Object.values(byId)) {
          if (row !== null && typeof row === 'object' && ((row.retainedBy ?? {}).mainView ?? 0) > 0) {
            return row
          }
        }
        return undefined
      })
    }

    function openSession(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      try {
        const workspace = ctx.get('uiWorkspace')
        if (workspace && typeof workspace.openSession === 'function') {
          workspace.openSession(sessionId)
          return
        }
      } catch (err) {
        /* fall through to the conversation panel */
      }
      try {
        ctx.get('layout')?.selectPanel?.('conversation')
      } catch (err) {
        /* nothing else to try */
      }
    }

    function openPanel(ctx) {
      try {
        ctx.get('layout')?.selectPanel?.(PANEL_ID)
      } catch (err) {
        /* the panel is not registered yet */
      }
    }

    // --------------------------------------------------------------- CSS

    const CSS = `
.dstq-page{
  --q-bg:#f7f8fa;--q-panel:#ffffff;--q-panel-2:#fafafa;--q-ink:#18181b;--q-dim:#71717a;--q-faint:#a1a1aa;
  --q-line:#e8e8ec;--q-line-strong:#d4d4d8;--q-blue:#2563eb;--q-green:#16a34a;--q-amber:#d97706;
  --q-red:#dc2626;--q-solid:#18181b;--q-solid-ink:#ffffff;
  box-sizing:border-box;height:100vh;height:100dvh;overflow-y:auto;overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch;
  padding:calc(var(--dsh-frame-top-clearance,0px) + 24px) 28px 42px;
  background:var(--q-bg);color:var(--q-ink);font-size:13.5px;line-height:1.55;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  color-scheme:light;
}
body[data-ds-dark-theme] .dstq-page{
  --q-bg:#0b0d10;--q-panel:#121417;--q-panel-2:#0f1114;--q-ink:#ececf1;--q-dim:#9b9ba4;--q-faint:#6b6b74;
  --q-line:#232529;--q-line-strong:#34363c;--q-blue:#60a5fa;--q-green:#4ade80;--q-amber:#fbbf24;
  --q-red:#f87171;--q-solid:#ececf1;--q-solid-ink:#0b0d10;
  color-scheme:dark;
}
.dstq-page *{box-sizing:border-box}
.dstq-shell{width:100%;max-width:1160px;margin:0 auto}
.dstq-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.dstq-kicker{font-size:10px;letter-spacing:.14em;font-weight:600;color:var(--q-faint);text-transform:uppercase;margin-bottom:5px}
.dstq-title{font-size:24px;line-height:1.2;font-weight:650;letter-spacing:-.015em;margin:0}
.dstq-sub{margin:6px 0 0;color:var(--q-dim);font-size:12.5px;max-width:620px}
.dstq-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dstq-stats{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px}
.dstq-stat{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--q-dim)}
.dstq-stat b{font-size:12px;color:var(--q-ink);font-weight:600;font-variant-numeric:tabular-nums}
.dstq-stat .dot{width:5px;height:5px;border-radius:50%;background:var(--q-faint)}
.dstq-stat.run .dot{background:var(--q-blue)}
.dstq-stat.review .dot{background:var(--q-amber)}
.dstq-stat.ok .dot{background:var(--q-green)}
.dstq-stat.bad .dot{background:var(--q-red)}
.dstq-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
.dstq-lane{background:var(--q-panel);border:1px solid var(--q-line);border-radius:12px;overflow:hidden;min-height:220px}
.dstq-lane-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 15px;border-bottom:1px solid var(--q-line)}
.dstq-lane-title{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13.5px;min-width:0}
.dstq-lane-title .dot{width:6px;height:6px;border-radius:50%;background:var(--q-faint);flex:none}
.dstq-lane-title .dot.run{background:var(--q-blue)}
.dstq-lane-sub{font-size:11.5px;color:var(--q-faint);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.dstq-lane-meta{font-size:11.5px;color:var(--q-faint);display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.dstq-lane-body{padding:12px 12px 14px;display:flex;flex-direction:column;gap:8px}
.dstq-section{display:flex;flex-direction:column;gap:7px}
.dstq-section-title{display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:600;letter-spacing:.08em;
  color:var(--q-faint);text-transform:uppercase;margin:2px 1px 0}
.dstq-section-title .count{font-weight:500;letter-spacing:0;color:var(--q-faint)}
.dstq-empty{border:1px dashed var(--q-line-strong);border-radius:9px;padding:16px 12px;text-align:center;
  color:var(--q-faint);font-size:12px}
.dstq-card{position:relative;border:1px solid var(--q-line);border-left:2px solid transparent;border-radius:9px;
  background:var(--q-panel);padding:10px 12px;display:flex;flex-direction:column;gap:7px;transition:border-color .15s}
.dstq-card:hover{border-color:var(--q-line-strong)}
.dstq-card[data-status="running"]{border-left-color:var(--q-blue)}
.dstq-card[data-status="review"]{border-left-color:var(--q-amber)}
.dstq-card[data-status="failed"]{border-left-color:var(--q-red)}
.dstq-card[data-status="accepted"]{opacity:.68}
.dstq-card-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dstq-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;padding:0;border:0;background:transparent;white-space:nowrap;color:var(--q-dim)}
.dstq-badge.idle{color:var(--q-faint)}
.dstq-badge.run{color:var(--q-blue)}
.dstq-badge.review{color:var(--q-amber)}
.dstq-badge.ok{color:var(--q-green)}
.dstq-badge.bad{color:var(--q-red)}
.dstq-card-title{margin:0;font-size:13.5px;line-height:1.4;font-weight:600;letter-spacing:-.005em;word-break:break-word}
.dstq-note{margin:0;color:var(--q-dim);font-size:12px;white-space:pre-wrap;word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dstq-note.open{display:block;-webkit-line-clamp:unset}
.dstq-feedback{margin:0;padding:7px 9px;border-radius:7px;background:var(--q-panel-2);color:var(--q-dim);
  font-size:11.5px;border:1px solid var(--q-line)}
.dstq-feedback b{color:var(--q-ink);font-weight:600}
.dstq-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--q-faint);font-size:11px}
.dstq-meta .sep{width:2px;height:2px;border-radius:50%;background:var(--q-faint)}
.dstq-meta .err{color:var(--q-red)}
.dstq-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:1px}
.dstq-btn{appearance:none;border:1px solid transparent;background:transparent;color:var(--q-dim);
  font:inherit;font-size:11.5px;font-weight:500;line-height:1;padding:6px 8px;border-radius:7px;cursor:pointer;
  display:inline-flex;align-items:center;gap:5px;min-height:28px;transition:background .14s,color .14s,border-color .14s}
.dstq-btn:hover{background:var(--q-panel-2);color:var(--q-ink)}
.dstq-btn:active{transform:translateY(1px)}
.dstq-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.dstq-btn.primary{background:var(--q-solid);border-color:var(--q-solid);color:var(--q-solid-ink)}
.dstq-btn.primary:hover{opacity:.88;color:var(--q-solid-ink)}
.dstq-btn.good{background:var(--q-solid);border-color:var(--q-solid);color:var(--q-solid-ink)}
.dstq-btn.good:hover{opacity:.88}
.dstq-btn.danger{color:var(--q-red)}
.dstq-btn.danger:hover{background:var(--q-panel-2);color:var(--q-red)}
.dstq-btn.ghost{border-color:transparent;background:transparent;color:var(--q-dim)}
.dstq-btn.ghost:hover{background:var(--q-panel-2);color:var(--q-ink)}
.dstq-btn.icon{min-width:28px;padding:5px 7px;justify-content:center;color:var(--q-faint)}
.dstq-review-box{display:flex;flex-direction:column;gap:7px;margin-top:1px;padding-top:8px;border-top:1px solid var(--q-line)}
.dstq-textarea{width:100%;min-height:66px;resize:vertical;border:1px solid var(--q-line-strong);border-radius:8px;
  padding:8px 9px;font:inherit;font-size:12px;line-height:1.5;color:var(--q-ink);background:var(--q-panel);outline:none}
.dstq-textarea:focus{border-color:var(--q-blue)}
.dstq-textarea::placeholder{color:var(--q-faint)}
.dstq-tabs{display:flex;gap:4px;flex-wrap:wrap;padding:0 12px 10px}
.dstq-tab{border:1px solid transparent;background:transparent;color:var(--q-faint);font:inherit;font-size:11.5px;
  font-weight:500;padding:5px 8px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;max-width:100%}
.dstq-tab .n{font-size:10.5px;color:var(--q-faint);font-variant-numeric:tabular-nums}
.dstq-tab:hover{background:var(--q-panel-2);color:var(--q-ink)}
.dstq-tab.active{background:var(--q-panel-2);color:var(--q-ink)}
.dstq-tab.active .n{color:var(--q-dim)}
.dstq-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;
  background:var(--q-solid,#18181b);color:var(--q-solid-ink,#fff);border-radius:8px;padding:9px 13px;
  font-size:12.5px;font-weight:500;box-shadow:0 10px 30px -14px rgba(0,0,0,.45);max-width:min(520px,calc(100vw - 32px))}
.dstq-toast.error{background:#b91c1c;color:#fff}
.dstq-modal-mask{position:fixed;inset:0;z-index:2147482500;background:rgba(9,12,18,.36);
  display:flex;align-items:center;justify-content:center;padding:20px}
.dstq-modal{width:min(520px,100%);max-height:min(86vh,720px);overflow:auto;background:var(--q-panel);
  border:1px solid var(--q-line);border-radius:12px;box-shadow:0 24px 60px -30px rgba(0,0,0,.45);padding:18px}
.dstq-modal h2{margin:0 0 4px;font-size:16px;font-weight:650}
.dstq-modal p.hint{margin:0 0 15px;color:var(--q-dim);font-size:12px}
.dstq-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.dstq-field label{font-size:11.5px;font-weight:600;color:var(--q-dim)}
.dstq-input,.dstq-select{width:100%;border:1px solid var(--q-line-strong);border-radius:8px;background:var(--q-panel);
  color:var(--q-ink);font:inherit;font-size:12.5px;padding:8px 9px;outline:none;min-height:36px}
.dstq-input:focus,.dstq-select:focus{border-color:var(--q-blue)}
.dstq-seg{display:flex;gap:3px;background:var(--q-panel-2);border:1px solid var(--q-line);padding:3px;border-radius:8px}
.dstq-seg button{flex:1;border:0;background:transparent;color:var(--q-dim);font:inherit;font-size:12px;font-weight:500;
  padding:7px 8px;border-radius:6px;cursor:pointer}
.dstq-seg button.active{background:var(--q-panel);color:var(--q-ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.dstq-form-error{color:var(--q-red);font-size:12px;border:1px solid var(--q-line);border-radius:7px;padding:7px 9px;margin-bottom:11px}
.dstq-modal-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:4px}
.dstq-footnote{color:var(--q-faint);font-size:11px;margin-top:6px;line-height:1.5}
.dstq-error-banner{border:1px solid var(--q-line);background:var(--q-panel);color:var(--q-red);
  border-radius:9px;padding:10px 12px;font-size:12.5px;margin-bottom:13px;display:flex;justify-content:space-between;gap:12px;align-items:center}

/* review overlay */
.dstq-float{position:fixed;right:16px;bottom:88px;z-index:2147482000;width:min(340px,calc(100vw - 24px));
  --q-panel:#ffffff;--q-panel-2:#fafafa;--q-ink:#18181b;--q-dim:#71717a;--q-faint:#a1a1aa;
  --q-line:#e8e8ec;--q-line-strong:#d4d4d8;--q-blue:#2563eb;--q-green:#16a34a;--q-amber:#d97706;
  --q-red:#dc2626;--q-solid:#18181b;--q-solid-ink:#ffffff;
  background:var(--q-panel);color:var(--q-ink);border:1px solid var(--q-line);
  border-radius:12px;box-shadow:0 18px 50px -24px rgba(0,0,0,.35);padding:13px;font-size:12.5px;line-height:1.5;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.dstq-float *{box-sizing:border-box}
.dstq-float-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:6px}
.dstq-float-kicker{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:600;letter-spacing:.1em;
  color:var(--q-amber);text-transform:uppercase}
.dstq-float-kicker .dot{width:5px;height:5px;border-radius:50%;background:var(--q-amber)}
.dstq-float-title{font-size:13.5px;font-weight:600;margin:2px 0 0;line-height:1.4;word-break:break-word}
.dstq-float-close{border:0;background:transparent;color:var(--q-faint);cursor:pointer;font-size:16px;line-height:1;padding:1px 3px}
.dstq-float-meta{font-size:11px;color:var(--q-faint);display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px}
.dstq-float-meta .sep{width:2px;height:2px;border-radius:50%;background:var(--q-faint)}
.dstq-float-actions{display:flex;gap:5px;flex-wrap:wrap}
.dstq-float-suggest{display:flex;flex-direction:column;gap:7px;margin-top:9px}
.dstq-float .dstq-textarea{min-height:60px}
.dstq-float .dstq-btn{font-size:11.5px;padding:6px 9px;min-height:30px}
body[data-ds-dark-theme] .dstq-float{--q-panel:#121417;--q-panel-2:#0f1114;--q-ink:#ececf1;--q-dim:#9b9ba4;
  --q-faint:#6b6b74;--q-line:#232529;--q-line-strong:#34363c;--q-blue:#60a5fa;--q-green:#4ade80;
  --q-amber:#fbbf24;--q-red:#f87171;--q-solid:#ececf1;--q-solid-ink:#0b0d10;background:#121417;color:#ececf1}
body[data-ds-dark-theme] .dstq-float .dstq-textarea{background:#0f1114;color:#ececf1;border-color:#34363c}

@media (max-width:900px){
  .dstq-page{padding:calc(var(--dsh-frame-top-clearance,0px) + 18px) 16px 38px}
  .dstq-layout{grid-template-columns:minmax(0,1fr)}
  .dstq-title{font-size:22px}
}
@media (max-width:640px){
  .dstq-page{padding:calc(var(--dsh-frame-top-clearance,0px) + 14px) 12px 32px;font-size:13px}
  .dstq-head{align-items:flex-start;margin-bottom:14px}
  .dstq-title{font-size:21px}
  .dstq-head-actions{width:100%}
  .dstq-head-actions .dstq-btn{flex:1;justify-content:center;min-height:36px}
  .dstq-stats{gap:12px}
  .dstq-lane-body{padding:10px 9px 12px}
  .dstq-card{padding:10px}
  .dstq-btn{min-height:34px;padding:7px 9px}
  .dstq-modal-mask{padding:0;align-items:flex-end}
  .dstq-modal{max-height:92vh;border-radius:14px 14px 0 0;border-bottom:0;padding:16px 14px calc(16px + env(safe-area-inset-bottom))}
  .dstq-toast{bottom:16px}
  .dstq-float{right:8px;left:8px;bottom:calc(76px + env(safe-area-inset-bottom));width:auto}
}
@media (prefers-reduced-motion:reduce){
  .dstq-card,.dstq-btn{transition:none}
}
`

    // ------------------------------------------------------------- components

    function TodoIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 6.5h9M4 12h6M4 17.5h7' }),
        h('path', { d: 'M14.5 15.5l2 2 4-4.5' }),
        h('path', { d: 'M14.5 6.5h5' }),
      )
    }

    function Badge(props) {
      const status = props.status
      return h(
        'span',
        { className: 'dstq-badge ' + (STATUS_CLASS[status] || 'idle') },
        h('span', {
          className: 'dot',
          style: {
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'currentColor',
            display: 'inline-block',
          },
        }),
        STATUS_LABEL[status] || status,
      )
    }

    function Empty(props) {
      return h('div', { className: 'dstq-empty' }, props.children)
    }

    function SectionTitle(props) {
      return h(
        'div',
        { className: 'dstq-section-title' },
        props.name,
        props.count === undefined ? null : h('span', { className: 'count' }, '(' + props.count + ')'),
      )
    }

    function TodoCard(props) {
      const { todo, ctx, busy, act, onEdit, onOpen, suggesting, suggestText, onSuggestText, onStartSuggest, onCancelSuggest } = props
      const [noteOpen, setNoteOpen] = React.useState(false)
      const disabled = busy === todo.id
      const canEdit = todo.status !== 'running'
      const feedback = Array.isArray(todo.feedback) ? todo.feedback : []

      const buttons = []
      if (todo.status === 'running') {
        buttons.push(
          h(
            'button',
            { key: 'open', className: 'dstq-btn primary', onClick: () => onOpen(todo) },
            '打开会话',
          ),
        )
      }
      if (todo.status === 'review') {
        buttons.push(
          h(
            'button',
            {
              key: 'accept',
              className: 'dstq-btn good',
              disabled,
              onClick: () => act('accept', { id: todo.id }, '已验收：「' + todo.title + '」'),
            },
            '完成验收',
          ),
          h(
            'button',
            {
              key: 'suggest',
              className: 'dstq-btn primary',
              disabled,
              onClick: () => (suggesting ? onCancelSuggest() : onStartSuggest(todo)),
            },
            suggesting ? '收起建议' : '修改建议',
          ),
          h(
            'button',
            { key: 'open', className: 'dstq-btn ghost', onClick: () => onOpen(todo) },
            '打开会话',
          ),
        )
      }
      if (todo.status === 'pending') {
        buttons.push(
          h(
            'button',
            {
              key: 'up',
              className: 'dstq-btn icon',
              title: '上移',
              disabled,
              onClick: () => act('move', { id: todo.id, direction: 'up' }, '已上移'),
            },
            '↑',
          ),
          h(
            'button',
            {
              key: 'down',
              className: 'dstq-btn icon',
              title: '下移',
              disabled,
              onClick: () => act('move', { id: todo.id, direction: 'down' }, '已下移'),
            },
            '↓',
          ),
        )
      }
      if (todo.status === 'failed' || todo.status === 'accepted') {
        buttons.push(
          h(
            'button',
            {
              key: 'retry',
              className: 'dstq-btn primary',
              disabled,
              onClick: () => act('run', { id: todo.id }, '已重新排队：「' + todo.title + '」'),
            },
            '重新排队',
          ),
        )
      }
      if (canEdit) {
        buttons.push(
          h(
            'button',
            { key: 'edit', className: 'dstq-btn ghost', disabled, onClick: () => onEdit(todo) },
            '编辑',
          ),
        )
      }
      if (todo.status !== 'running') {
        buttons.push(
          h(
            'button',
            {
              key: 'delete',
              className: 'dstq-btn danger',
              disabled,
              onClick: () => {
                if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm('删除这条待办？')) return
                void act('remove', { id: todo.id }, '已删除：「' + todo.title + '」')
              },
            },
            '删除',
          ),
        )
      }

      return h(
        'article',
        { className: 'dstq-card', 'data-status': todo.status, 'data-id': todo.id },
        h('div', { className: 'dstq-card-top' }, h(Badge, { status: todo.status })),
        h('h3', { className: 'dstq-card-title' }, todo.title),
        todo.note
          ? h(
              'p',
              {
                className: 'dstq-note' + (noteOpen ? ' open' : ''),
                onClick: () => setNoteOpen((open) => !open),
                title: noteOpen ? '点击收起' : '点击展开',
              },
              todo.note,
            )
          : null,
        feedback.length > 0
          ? h(
              'div',
              { className: 'dstq-feedback' },
              h('b', null, '修改建议 ' + feedback.length + ' 条'),
              '：',
              feedback[feedback.length - 1].text,
            )
          : null,
        h(
          'div',
          { className: 'dstq-meta' },
          h('span', null, todo.queue === 'global' ? '全局队列' : todo.workspaceLabel + ' 队列'),
          todo.queue === 'global' ? h('span', { className: 'sep' }) : null,
          todo.queue === 'global' ? h('span', null, todo.workspaceLabel) : null,
          todo.status === 'running' ? h('span', { className: 'sep' }) : null,
          todo.status === 'running' ? h('span', null, '已运行 ' + Math.max(1, Math.round(todo.elapsedMs / 1000)) + ' 秒') : null,
          todo.status === 'review' && todo.reviewAt ? h('span', { className: 'sep' }) : null,
          todo.status === 'review' && todo.reviewAt ? h('span', null, '完成于 ' + formatClock(todo.reviewAt)) : null,
          todo.status === 'accepted' && todo.acceptedAt ? h('span', { className: 'sep' }) : null,
          todo.status === 'accepted' && todo.acceptedAt ? h('span', null, '验收于 ' + formatClock(todo.acceptedAt)) : null,
          todo.attempts > 0 && todo.status !== 'accepted' ? h('span', { className: 'sep' }) : null,
          todo.attempts > 0 && todo.status !== 'accepted' ? h('span', null, '第 ' + todo.attempts + ' 轮') : null,
          todo.error ? h('span', { className: 'sep' }) : null,
          todo.error ? h('span', { className: 'err' }, todo.error) : null,
        ),
        buttons.length > 0 ? h('div', { className: 'dstq-actions' }, buttons) : null,
        todo.status === 'review' && suggesting
          ? h(
              'div',
              { className: 'dstq-review-box' },
              h('textarea', {
                className: 'dstq-textarea',
                value: suggestText,
                placeholder: '写清楚要改什么；这条建议会进入下一轮派发的提示词。',
                onChange: (event) => onSuggestText(event.target.value),
                rows: 3,
              }),
              h(
                'div',
                { className: 'dstq-actions' },
                h(
                  'button',
                  {
                    className: 'dstq-btn primary',
                    disabled: disabled || suggestText.trim() === '',
                    onClick: () => act('sendBack', { id: todo.id, suggestion: suggestText }, '已退回待运行，等待队列派发'),
                  },
                  '退回待运行',
                ),
                h('button', { className: 'dstq-btn ghost', onClick: onCancelSuggest }, '取消'),
              ),
            )
          : null,
      )
    }

    function QueueLane(props) {
      const {
        title,
        subtitle,
        todos,
        emptyText,
        ctx,
        busy,
        act,
        onEdit,
        onOpen,
        suggesting,
        suggestText,
        onSuggestText,
        onStartSuggest,
        onCancelSuggest,
        onClearAccepted,
        tabs,
      } = props
      const running = todos.filter((todo) => todo.status === 'running')
      const review = todos.filter((todo) => todo.status === 'review')
      const pending = todos.filter((todo) => todo.status === 'pending')
      const failed = todos.filter((todo) => todo.status === 'failed')
      const accepted = todos.filter((todo) => todo.status === 'accepted')
      const total = todos.length
      const busyCount = running.length

      const card = (todo) =>
        h(TodoCard, {
          key: todo.id,
          todo,
          ctx,
          busy,
          act,
          onEdit,
          onOpen,
          suggesting: suggesting === todo.id,
          suggestText,
          onSuggestText,
          onStartSuggest,
          onCancelSuggest,
        })

      return h(
        'section',
        { className: 'dstq-lane', 'aria-label': title },
        h(
          'header',
          { className: 'dstq-lane-head' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h(
              'div',
              { className: 'dstq-lane-title' },
              h('span', { className: 'dot' + (busyCount > 0 ? ' run' : '') }),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
            ),
            subtitle ? h('div', { className: 'dstq-lane-sub' }, subtitle) : null,
          ),
          h(
            'div',
            { className: 'dstq-lane-meta' },
            h('span', null, busyCount > 0 ? '运行中' : '队列空闲'),
            h('span', null, '·'),
            h('span', null, total + ' 条'),
          ),
        ),
        tabs ? h('div', { className: 'dstq-tabs' }, tabs) : null,
        h(
          'div',
          { className: 'dstq-lane-body' },
          total === 0 ? h(Empty, null, emptyText) : null,
          running.length > 0
            ? h('div', { className: 'dstq-section' }, h(SectionTitle, { name: '运行中' }), running.map(card))
            : null,
          review.length > 0
            ? h('div', { className: 'dstq-section' }, h(SectionTitle, { name: '待验收', count: review.length }), review.map(card))
            : null,
          pending.length > 0
            ? h(
                'div',
                { className: 'dstq-section' },
                h(SectionTitle, { name: '排队中', count: pending.length }),
                pending.map(card),
              )
            : null,
          failed.length > 0
            ? h('div', { className: 'dstq-section' }, h(SectionTitle, { name: '异常', count: failed.length }), failed.map(card))
            : null,
          accepted.length > 0
            ? h(
                'div',
                { className: 'dstq-section' },
                h(SectionTitle, { name: '已验收', count: accepted.length }),
                accepted.slice(0, 6).map(card),
                accepted.length > 6 ? h('div', { className: 'dstq-empty' }, '只显示最近 6 条已验收') : null,
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'flex-end' } },
                  h(
                    'button',
                    { className: 'dstq-btn ghost', onClick: onClearAccepted },
                    '清空已验收',
                  ),
                ),
              )
            : null,
        ),
      )
    }

    function TodoForm(props) {
      const { form, setForm, onSubmit, busy, workspaces, current } = props
      const update = (patch) => setForm({ ...form, ...patch, error: '' })
      return h(
        'div',
        { className: 'dstq-modal-mask', onMouseDown: (event) => { if (event.target === event.currentTarget) setForm(null) } },
        h(
          'div',
          { className: 'dstq-modal', role: 'dialog', 'aria-modal': 'true' },
          h('h2', null, form.mode === 'create' ? '新建待办' : '编辑待办'),
          h(
            'p',
            { className: 'hint' },
            form.mode === 'create'
              ? '新待办会追加到队列底部；队列空闲时自动开一个新会话执行。'
              : '运行中的待办不能编辑；改队列或运行目录会让它重新排队并开新会话。',
          ),
          form.error ? h('div', { className: 'dstq-form-error' }, form.error) : null,
          h(
            'div',
            { className: 'dstq-field' },
            h('label', { htmlFor: 'dstq-title' }, '待办内容'),
            h('input', {
              id: 'dstq-title',
              className: 'dstq-input',
              value: form.title,
              autoFocus: true,
              placeholder: '一句话说清要做什么，可独立验收',
              onChange: (event) => update({ title: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'dstq-field' },
            h('label', { htmlFor: 'dstq-note' }, '备注（验收标准 / 前置条件 / 已知的坑）'),
            h('textarea', {
              id: 'dstq-note',
              className: 'dstq-textarea',
              rows: 4,
              value: form.note,
              placeholder: '可选。写清怎么算做完、不要做什么。',
              onChange: (event) => update({ note: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'dstq-field' },
            h('label', null, '队列'),
            h(
              'div',
              { className: 'dstq-seg' },
              h(
                'button',
                { className: form.queue === 'workspace' ? 'active' : '', onClick: () => update({ queue: 'workspace' }) },
                '工作区队列',
              ),
              h(
                'button',
                { className: form.queue === 'global' ? 'active' : '', onClick: () => update({ queue: 'global' }) },
                '全局队列',
              ),
            ),
            h(
              'div',
              { className: 'dstq-footnote' },
              form.queue === 'workspace'
                ? '每个工作目录各一条队列，彼此可以同时各跑一个会话。'
                : '全局队列跨工作目录串行：同一时间只跑一个会话。',
            ),
          ),
          h(
            'div',
            { className: 'dstq-field' },
            h('label', { htmlFor: 'dstq-workspace' }, '运行目录（新会话的 cwd）'),
            h('input', {
              id: 'dstq-workspace',
              className: 'dstq-input',
              value: form.workspace,
              list: 'dstq-workspaces',
              placeholder: current && current.cwd ? current.cwd : '/absolute/path',
              onChange: (event) => update({ workspace: event.target.value }),
            }),
            h(
              'datalist',
              { id: 'dstq-workspaces' },
              (workspaces || []).map((path) => h('option', { key: path, value: path })),
            ),
            h('div', { className: 'dstq-footnote' }, '必须是已存在的目录。建议直接用当前会话的工作目录。'),
          ),
          h(
            'div',
            { className: 'dstq-modal-actions' },
            h('button', { className: 'dstq-btn ghost', onClick: () => setForm(null) }, '取消'),
            h(
              'button',
              { className: 'dstq-btn primary', disabled: busy, onClick: onSubmit },
              busy ? '保存中…' : form.mode === 'create' ? '加入队列' : '保存修改',
            ),
          ),
        ),
      )
    }

    function TodoPageInner(props) {
      const { ctx, current } = props
      const { snapshot, error, refresh } = useSnapshot('')
      const [form, setForm] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [toast, setToast] = React.useState(null)
      const toastTimer = React.useRef(undefined)
      const [workspaceTab, setWorkspaceTab] = React.useState('')
      const [suggestFor, setSuggestFor] = React.useState('')
      const [suggestText, setSuggestText] = React.useState('')

      // On a phone the sidebar is a drawer. Selecting the TODO panel from that
      // drawer leaves it open (the shell's own choice), and the remaining
      // 110px column makes the panel look broken. Close it once on mount when
      // the viewport is phone-sized; the user can still open it again.
      React.useEffect(() => {
        if (typeof window === 'undefined' || window.innerWidth > 640) return
        const timer = setTimeout(() => {
          const toggle = [...document.querySelectorAll('button')].find((button) => {
            const label = button.getAttribute('aria-label') || ''
            if (/right|右/i.test(label)) return false
            return /slide|drawer|sidebar|侧栏/i.test(label) && /collapse|close|收起|关闭/i.test(label)
          })
          if (toggle !== undefined) toggle.click()
        }, 300)
        return () => clearTimeout(timer)
      }, [])

      const notify = React.useCallback((message, kind) => {
        setToast({ message, kind: kind || 'ok' })
        if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 3200)
      }, [])
      React.useEffect(() => () => { if (toastTimer.current !== undefined) clearTimeout(toastTimer.current) }, [])

      const act = React.useCallback(
        async (action, payload, message) => {
          const key = payload && payload.id ? payload.id : action
          setBusy(key)
          try {
            await post(action, payload)
            notify(message || '已完成')
            await refresh()
            setSuggestFor('')
            setSuggestText('')
          } catch (err) {
            notify(errText(err), 'error')
          } finally {
            setBusy('')
          }
        },
        [notify, refresh],
      )

      const todos = snapshot && Array.isArray(snapshot.todos) ? snapshot.todos : []
      const stats = (snapshot && snapshot.stats) || { pending: 0, running: 0, review: 0, accepted: 0, failed: 0 }
      const workspacePaths = React.useMemo(() => {
        const set = new Set()
        for (const path of (snapshot && Array.isArray(snapshot.workspaces) ? snapshot.workspaces : [])) {
          if (typeof path === 'string' && path !== '') set.add(path)
        }
        if (current && typeof current.cwd === 'string' && current.cwd !== '') set.add(current.cwd)
        return [...set].sort((left, right) => left.localeCompare(right))
      }, [snapshot, current])

      const activeWorkspace = React.useMemo(() => {
        if (workspaceTab && workspacePaths.indexOf(workspaceTab) >= 0) return workspaceTab
        if (current && current.cwd && workspacePaths.indexOf(current.cwd) >= 0) return current.cwd
        return workspacePaths[0] || ''
      }, [workspaceTab, workspacePaths, current])

      const globalTodos = todos.filter((todo) => todo.queue === 'global')
      const workspaceTodos = todos.filter(
        (todo) => todo.queue === 'workspace' && todo.workspace === activeWorkspace,
      )

      const openCreate = () => {
        setForm({
          mode: 'create',
          title: '',
          note: '',
          queue: activeWorkspace ? 'workspace' : 'global',
          workspace: activeWorkspace || (current && current.cwd) || '',
          error: '',
        })
      }
      const openEdit = (todo) => {
        setForm({
          mode: 'edit',
          id: todo.id,
          title: todo.title,
          note: todo.note || '',
          queue: todo.queue,
          workspace: todo.workspace,
          error: '',
        })
      }
      const submitForm = async () => {
        if (!form) return
        const title = form.title.trim()
        if (title === '') {
          setForm({ ...form, error: '待办内容不能为空。' })
          return
        }
        if (form.queue === 'workspace' && form.workspace.trim() === '') {
          setForm({ ...form, error: '工作区队列需要填写运行目录。' })
          return
        }
        setBusy('form')
        try {
          if (form.mode === 'create') {
            await post('create', {
              title,
              note: form.note,
              queue: form.queue,
              workspace: form.workspace,
              sessionId: current && current.id ? current.id : '',
            })
            notify('已加入队列')
          } else {
            await post('patch', {
              id: form.id,
              title,
              note: form.note,
              queue: form.queue,
              workspace: form.workspace,
            })
            notify('已保存')
          }
          if (form.queue === 'workspace' && form.workspace.trim() !== '') {
            setWorkspaceTab(form.workspace.trim())
          }
          setForm(null)
          await refresh()
        } catch (err) {
          setForm({ ...form, error: errText(err), busy: false })
        } finally {
          setBusy('')
        }
      }

      const startSuggest = (todo) => {
        setSuggestFor(todo.id)
        setSuggestText('')
      }
      const cancelSuggest = () => {
        setSuggestFor('')
        setSuggestText('')
      }

      if (error && !snapshot) {
        return h(
          'div',
          { className: 'dstq-page' },
          h(
            'div',
            { className: 'dstq-shell' },
            h('div', { className: 'dstq-error-banner' }, h('span', null, '队列板加载失败：' + error), h('button', { className: 'dstq-btn', onClick: refresh }, '重试')),
          ),
        )
      }

      return h(
        'div',
        { className: 'dstq-page' },
        h(
          'div',
          { className: 'dstq-shell' },
          h(
            'header',
            { className: 'dstq-head' },
            h(
              'div',
              null,
              h('div', { className: 'dstq-kicker' }, '串行调度'),
              h('h1', { className: 'dstq-title' }, 'TODO 队列'),
              h(
                'p',
                { className: 'dstq-sub' },
                '每条队列同一时间只跑一个会话；会话一结束，这条就进入待验收，队列自动把下一条派出去。',
              ),
              h(
                'div',
                { className: 'dstq-stats' },
                h('span', { className: 'dstq-stat run' }, h('span', { className: 'dot' }), h('b', null, stats.running), '运行中'),
                h('span', { className: 'dstq-stat review' }, h('span', { className: 'dot' }), h('b', null, stats.review), '待验收'),
                h('span', { className: 'dstq-stat' }, h('span', { className: 'dot' }), h('b', null, stats.pending), '待运行'),
                h('span', { className: 'dstq-stat ok' }, h('span', { className: 'dot' }), h('b', null, stats.accepted), '已验收'),
                stats.failed > 0 ? h('span', { className: 'dstq-stat bad' }, h('span', { className: 'dot' }), h('b', null, stats.failed), '异常') : null,
              ),
            ),
            h(
              'div',
              { className: 'dstq-head-actions' },
              h('button', { className: 'dstq-btn ghost', onClick: refresh, title: '立即刷新' }, '刷新'),
              h('button', { className: 'dstq-btn primary', onClick: openCreate }, '＋ 新建待办'),
            ),
          ),
          error ? h('div', { className: 'dstq-error-banner' }, h('span', null, '刷新失败：' + error), h('button', { className: 'dstq-btn', onClick: refresh }, '重试')) : null,
          h(
            'div',
            { className: 'dstq-layout' },
            h(QueueLane, {
              title: '全局队列',
              subtitle: '跨工作目录串行 · 同一时间一个会话',
              todos: globalTodos,
              emptyText: '全局队列里还没有待办。新建时选「全局队列」会排到这里。',
              ctx,
              busy,
              act,
              onEdit: openEdit,
              onOpen: (todo) => openSession(ctx, todo.sessionId),
              suggesting: suggestFor,
              suggestText,
              onSuggestText: setSuggestText,
              onStartSuggest: startSuggest,
              onCancelSuggest: cancelSuggest,
              onClearAccepted: () => act('clearAccepted', {}, '已清空已验收'),
            }),
            h(QueueLane, {
              title: '工作区队列',
              subtitle: activeWorkspace || '还没有工作区',
              todos: workspaceTodos,
              emptyText: activeWorkspace
                ? '「' + activeWorkspace + '」的队列是空的。'
                : '还没有工作区队列。新建待办时选「工作区队列」。',
              ctx,
              busy,
              act,
              onEdit: openEdit,
              onOpen: (todo) => openSession(ctx, todo.sessionId),
              suggesting: suggestFor,
              suggestText,
              onSuggestText: setSuggestText,
              onStartSuggest: startSuggest,
              onCancelSuggest: cancelSuggest,
              onClearAccepted: () => act('clearAccepted', {}, '已清空已验收'),
              tabs: workspacePaths.length > 1
                ? workspacePaths.map((path) =>
                    h(
                      'button',
                      {
                        key: path,
                        className: 'dstq-tab' + (path === activeWorkspace ? ' active' : ''),
                        onClick: () => setWorkspaceTab(path),
                        title: path,
                      },
                      path.split(/[\\/]/).filter(Boolean).slice(-1)[0] || path,
                      h(
                        'span',
                        { className: 'n' },
                        todos.filter((todo) => todo.queue === 'workspace' && todo.workspace === path).length,
                      ),
                    ),
                  )
                : null,
            }),
          ),
          h(
            'p',
            { className: 'dstq-footnote', style: { marginTop: 16 } },
            '队列由 Host 调度，关掉网页也会继续跑。待验收的会话打开时，会话里会出现快捷浮窗。',
          ),
          toast ? h('div', { className: 'dstq-toast' + (toast.kind === 'error' ? ' error' : '') }, toast.message) : null,
          form
            ? h(TodoForm, {
                form,
                setForm,
                onSubmit: submitForm,
                busy: busy === 'form',
                workspaces: workspacePaths,
                current,
              })
            : null,
        ),
      )
    }

    function TodoPage(props) {
      if (typeof props.useSessions !== 'function') return h(TodoPageInner, { ctx: props.ctx, current: undefined })
      return h(TodoPageWithSessions, props)
    }

    function TodoPageWithSessions(props) {
      const currentSession = useCurrentSession(props.useSessions)
      const current =
        currentSession && typeof currentSession === 'object'
          ? { id: currentSession.id, cwd: currentSession.cwd, title: currentSession.title }
          : undefined
      return h(TodoPageInner, { ctx: props.ctx, current })
    }

    function ReviewOverlayInner(props) {
      const { ctx, currentId, activePanel } = props
      const { snapshot, error } = useSnapshot(currentId)
      const [dismissed, setDismissed] = React.useState('')
      const [suggestOpen, setSuggestOpen] = React.useState(false)
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        setDismissed('')
        setSuggestOpen(false)
        setText('')
        setNotice('')
      }, [currentId])

      const todo = snapshot && snapshot.sessionTodo && snapshot.sessionTodo.status === 'review' ? snapshot.sessionTodo : null
      if (activePanel !== null) return null
      if (!todo || dismissed === todo.id) return null

      const act = async (action, payload, message) => {
        setBusy(action)
        setNotice('')
        try {
          await post(action, payload)
          setNotice(message)
          if (action === 'accept' || action === 'sendBack') {
            setSuggestOpen(false)
            setText('')
          }
        } catch (err) {
          setNotice(errText(err))
        } finally {
          setBusy('')
        }
      }

      const feedback = Array.isArray(todo.feedback) ? todo.feedback : []

      return h(
        'aside',
        { className: 'dstq-float', 'aria-label': '待验收快捷操作' },
        h(
          'div',
          { className: 'dstq-float-head' },
          h(
            'div',
            null,
            h('div', { className: 'dstq-float-kicker' }, h('span', { className: 'dot' }), 'TODO 队列 · 待验收'),
            h('h2', { className: 'dstq-float-title' }, todo.title),
          ),
          h(
            'button',
            {
              className: 'dstq-float-close',
              title: '收起',
              'aria-label': '收起浮窗',
              onClick: () => setDismissed(todo.id),
            },
            '×',
          ),
        ),
        h(
          'div',
          { className: 'dstq-float-meta' },
          h('span', null, todo.queueLabel),
          h('span', { className: 'sep' }),
          h('span', null, todo.workspaceLabel),
          feedback.length > 0 ? h('span', { className: 'sep' }) : null,
          feedback.length > 0 ? h('span', null, '修改建议 ' + feedback.length + ' 条') : null,
        ),
        h(
          'div',
          { className: 'dstq-float-actions' },
          h(
            'button',
            {
              className: 'dstq-btn good',
              disabled: busy !== '',
              onClick: () => act('accept', { id: todo.id }, '已验收'),
            },
            busy === 'accept' ? '验收中…' : '完成验收',
          ),
          h(
            'button',
            {
              className: 'dstq-btn primary',
              disabled: busy !== '',
              onClick: () => setSuggestOpen((open) => !open),
            },
            suggestOpen ? '收起建议' : '修改建议',
          ),
          h(
            'button',
            { className: 'dstq-btn ghost', onClick: () => openPanel(ctx) },
            '打开面板',
          ),
        ),
        suggestOpen
          ? h(
              'div',
              { className: 'dstq-float-suggest' },
              h('textarea', {
                className: 'dstq-textarea',
                rows: 3,
                value: text,
                placeholder: '要改什么？这条建议会进入下一轮派发的提示词。',
                onChange: (event) => setText(event.target.value),
              }),
              h(
                'div',
                { className: 'dstq-float-actions' },
                h(
                  'button',
                  {
                    className: 'dstq-btn primary',
                    disabled: busy !== '' || text.trim() === '',
                    onClick: () => act('sendBack', { id: todo.id, suggestion: text }, '已退回待运行'),
                  },
                  busy === 'sendBack' ? '提交中…' : '退回待运行',
                ),
              ),
            )
          : null,
        error ? h('div', { className: 'dstq-footnote', style: { color: '#cc2d2d' } }, error) : null,
        notice ? h('div', { className: 'dstq-footnote' }, notice) : null,
      )
    }

    function ReviewOverlay(props) {
      if (typeof props.useSessions !== 'function') return null
      return h(ReviewOverlayWithSession, props)
    }

    function ReviewOverlayWithSession(props) {
      const currentSession = useCurrentSession(props.useSessions)
      const currentId = currentSession && typeof currentSession.id === 'string' ? currentSession.id : ''
      const activePanel = useActivePanel(props.usePanelInfo)
      return h(ReviewOverlayInner, { ctx: props.ctx, currentId, activePanel })
    }

    // ------------------------------------------------------------------ apply

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-todo-queue')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-todo-queue: styles')

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ ctx }),
          },
          TodoPage,
        ),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 12,
            label: () => 'TODO 板',
          },
          TodoIcon,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'todo-queue.review',
            order: 45,
            label: 'TODO 待验收',
            inject: () => ({ ctx }),
          },
          ReviewOverlay,
        ),
      )
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    module.exports.PANEL_ID = PANEL_ID
    return module.exports
  },
})
