import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { InboxItem, PlanItem, Todo } from '../types'

const PANE = 'task-inbox'
const TITLE = 'Tasks'

const plan = atom({ plugin: 'task-inbox', key: 'plan' } as const, [])
const todos = atom({ plugin: 'task-inbox', key: 'todos' } as const, [])
const inbox = atom({ plugin: 'task-inbox', key: 'inbox' } as const, [])

function newId(now: number): string {
  return `${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

// The one prompt that hands the queued tasks to background subagents.
function dispatchPrompt(items: readonly InboxItem[]): string {
  const list = items.map((it, i) => `${i + 1}. ${it.text}`).join('\n')
  return [
    `Inbox dispatch (${items.length} task${items.length === 1 ? '' : 's'}). Run each task below in its own background subagent`,
    '(Agent tool, run_in_background: true), all spawned in one message so they run in parallel.',
    'Give each subagent a self-contained prompt with the context it needs.',
    'Pick the cheapest model that will do the task well: haiku for search, lookup and summaries;',
    'sonnet for routine, well-specified edits; leave the model unset for hard design or debugging.',
    'Do not wait on them; when each finishes, report one line: task, outcome, and anything I must decide.',
    '',
    list,
  ].join('\n')
}

async function persist($: EngineInterface, project: string) {
  await $.store.set(`todos:${project}`, await read($, todos))
  await $.store.set(`inbox:${project}`, await read($, inbox))
}

async function addTodo($: EngineInterface, project: string, text: string) {
  const now = await $.clock.now()
  await update($, todos, list => [...list, { id: newId(now), text, isDone: false, createdAt: now }])
  await persist($, project)
}

async function addInbox($: EngineInterface, project: string, text: string) {
  const now = await $.clock.now()
  await update($, inbox, list => [...list, { id: newId(now), text, status: 'queued' as const, sentAt: null }])
  await persist($, project)
}

async function dispatch($: EngineInterface, project: string, ids: readonly string[] | null): Promise<number> {
  const list = await read($, inbox)
  const picked = list.filter(it => it.status === 'queued' && (ids === null || ids.includes(it.id)))
  if (picked.length === 0) return 0
  // Submitted on a timer: a prompt cannot be submitted from inside the
  // command or press that holds the session, only once it has returned.
  const text = dispatchPrompt(picked)
  $.clock.after(100, () => void $.prompt.submit({ text }))
  const now = await $.clock.now()
  const sent = new Set(picked.map(it => it.id))
  await update($, inbox, l => l.map(it => (sent.has(it.id) ? { ...it, status: 'sent' as const, sentAt: now } : it)))
  await persist($, project)
  return picked.length
}

async function refreshStatus($: EngineInterface) {
  const p = await read($, plan)
  const mine = (await read($, todos)).filter(t => !t.isDone).length
  const queued = (await read($, inbox)).filter(it => it.status === 'queued').length
  const parts: string[] = []
  if (p.length > 0) parts.push(`plan ${p.filter(x => x.status === 'completed').length}/${p.length}`)
  if (mine > 0) parts.push(`${mine} to-do`)
  if (queued > 0) parts.push(`${queued} in inbox`)
  $.ui.status(parts.length > 0 ? `☑ ${parts.join(' · ')}` : undefined)
}

export const register: Register = on => {
  let project = ''

  on('session.start', async ($, e, next) => {
    project = e.cwd
    await $.command.register({
      name: 'todo',
      description: 'Your to-do list: /todo <text> adds, /todo done <n> ticks, /todo opens the Tasks pane',
      argumentHint: '[text | done <n> | rm <n> | clear]',
    })
    await $.command.register({
      name: 'inbox',
      description: 'Queue tasks for background subagents: /inbox <text> queues, /inbox send dispatches all',
      argumentHint: '[text | send | rm <n> | clear]',
    })
    const savedTodos = await $.store.get(`todos:${project}`)
    const savedInbox = await $.store.get(`inbox:${project}`)
    if (Array.isArray(savedTodos)) await update($, todos, () => savedTodos as Todo[])
    if (Array.isArray(savedInbox)) await update($, inbox, () => savedInbox as InboxItem[])
    await refreshStatus($)

    return next(e)
  })

  on('command.run', { command: 'todo' }, async ($, e) => {
    const args = e.args.trim()
    const list = await read($, todos)
    const open = list.filter(t => !t.isDone)
    const m = /^(done|rm)\s+(\d+)$/.exec(args)
    if (args === '') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: open.length === 0 ? 'No open to-dos.' : open.map((t, i) => `${i + 1}. ${t.text}`).join('\n') }
    }
    if (args === 'clear') {
      await update($, todos, l => l.filter(t => !t.isDone))
      await persist($, project)
      await refreshStatus($)
      return { text: 'Cleared finished to-dos.' }
    }
    if (m) {
      const target = open[Number(m[2]) - 1]
      if (!target) return { text: `No open to-do #${m[2]}.` }
      await update($, todos, l =>
        m[1] === 'rm' ? l.filter(t => t.id !== target.id) : l.map(t => (t.id === target.id ? { ...t, isDone: true } : t)),
      )
      await persist($, project)
      await refreshStatus($)
      return { text: `${m[1] === 'rm' ? 'Removed' : 'Done'}: ${target.text}` }
    }
    await addTodo($, project, args)
    await refreshStatus($)
    return { text: `Added to-do #${open.length + 1}: ${args}` }
  })

  on('command.run', { command: 'inbox' }, async ($, e) => {
    const args = e.args.trim()
    const queued = (await read($, inbox)).filter(it => it.status === 'queued')
    const m = /^rm\s+(\d+)$/.exec(args)
    if (args === '') {
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: queued.length === 0 ? 'Inbox is empty.' : queued.map((it, i) => `${i + 1}. ${it.text}`).join('\n') }
    }
    if (args === 'send') {
      const n = await dispatch($, project, null)
      await refreshStatus($)
      return { text: n === 0 ? 'Nothing queued.' : `Dispatching ${n} task${n === 1 ? '' : 's'} to background subagents.` }
    }
    if (args === 'clear') {
      await update($, inbox, l => l.filter(it => it.status === 'queued'))
      await persist($, project)
      return { text: 'Cleared sent tasks.' }
    }
    if (m) {
      const target = queued[Number(m[1]) - 1]
      if (!target) return { text: `No queued task #${m[1]}.` }
      await update($, inbox, l => l.filter(it => it.id !== target.id))
      await persist($, project)
      await refreshStatus($)
      return { text: `Removed: ${target.text}` }
    }
    await addInbox($, project, args)
    await refreshStatus($)
    return { text: `Queued #${queued.length + 1}: ${args}. /inbox send dispatches the queue.` }
  })

  // Mirror Claude's own plan (TodoWrite, or TaskCreate/TaskUpdate) from the main loop.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      await update($, plan, () => e.todos.map((t, i): PlanItem => ({ id: String(i), text: t.content, status: t.status })))
      await refreshStatus($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const id = ran.result.task.id
      await update($, plan, l => [...l.filter(x => x.id !== id), { id, text: e.subject, status: 'pending' as const }])
      await refreshStatus($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const status = e.status
      await update($, plan, l =>
        status === 'deleted'
          ? l.filter(x => x.id !== e.taskId)
          : l.map(x => (x.id === e.taskId ? { ...x, text: e.subject ?? x.text, status: status ?? x.status } : x)),
      )
      await refreshStatus($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const width = Math.max(20, e.props.bodyColumns ?? 40)
    const p = await read($, plan)
    const mine = await read($, todos)
    const box = await read($, inbox)
    const queued = box.filter(it => it.status === 'queued')
    const sent = box.filter(it => it.status === 'sent')
    const mark = { pending: '☐', in_progress: '◐', completed: '☑' } as const
    const field = (key: string, placeholder: string, onSubmit: (text: string) => Promise<void>) =>
      'Input' in els ? (
        <els.Input key={key} placeholder={placeholder} submitLabel="Add" onSubmit={text => void (text.trim() && onSubmit(text.trim()))} />
      ) : null

    return (
      <Box flexDirection="column">
        <Text bold>Claude's plan {p.length > 0 ? `(${p.filter(x => x.status === 'completed').length}/${p.length})` : ''}</Text>
        {p.length === 0 && <Text dimColor>No plan yet. It fills in as Claude tracks its steps.</Text>}
        {p.map(x => (
          <Text key={`p-${x.id}`} color={x.status === 'in_progress' ? 'claude' : undefined} dimColor={x.status === 'completed'} wrap="truncate">
            {mark[x.status]} {clip(x.text, width - 3)}
          </Text>
        ))}

        <Box marginTop={1}>
          <Text bold>My to-dos ({mine.filter(t => !t.isDone).length})</Text>
        </Box>
        {mine.map(t => (
          <Box key={`t-${t.id}`} flexDirection="row">
            <Button
              key={`tt-${t.id}`}
              plain
              onPress={async () => {
                await update($, todos, l => l.map(x => (x.id === t.id ? { ...x, isDone: !x.isDone } : x)))
                await persist($, project)
                await refreshStatus($)
              }}
            >
              {t.isDone ? '☑' : '☐'} <Text dimColor={t.isDone} strikethrough={t.isDone}>{clip(t.text, width - 8)}</Text>
            </Button>
            <Button
              key={`tx-${t.id}`}
              plain
              dimColor
              label=" ✕"
              onPress={async () => {
                await update($, todos, l => l.filter(x => x.id !== t.id))
                await persist($, project)
                await refreshStatus($)
              }}
            />
          </Box>
        ))}
        {field('new-todo', 'Add a to-do…', async text => {
          await addTodo($, project, text)
          await refreshStatus($)
        })}

        <Box marginTop={1}>
          <Text bold>Inbox ({queued.length} queued)</Text>
        </Box>
        {queued.length === 0 && <Text dimColor>Queue tasks with /inbox &lt;task&gt;, then send them all at once.</Text>}
        {queued.map(it => (
          <Box key={`i-${it.id}`} flexDirection="row">
            <Text wrap="truncate">• {clip(it.text, width - 14)} </Text>
            <Button key={`is-${it.id}`} label="Send" onPress={async () => (await dispatch($, project, [it.id]), refreshStatus($))} />
            <Button
              key={`ix-${it.id}`}
              plain
              dimColor
              label=" ✕"
              onPress={async () => {
                await update($, inbox, l => l.filter(x => x.id !== it.id))
                await persist($, project)
                await refreshStatus($)
              }}
            />
          </Box>
        ))}
        {field('new-inbox', 'Queue a task for a subagent…', async text => {
          await addInbox($, project, text)
          await refreshStatus($)
        })}
        {queued.length > 1 && (
          <Button key="send-all" variant="primary" label={`Send all ${queued.length}`} onPress={async () => (await dispatch($, project, null), refreshStatus($))} />
        )}
        {sent.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Sent ({sent.length}): progress shows in /subagents</Text>
            {sent.slice(-5).map(it => (
              <Text key={`s-${it.id}`} dimColor wrap="truncate">
                ↗ {clip(it.text, width - 3)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
