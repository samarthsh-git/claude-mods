import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { AgentRun } from '../types'

const PANE = 'agent-monitor'
const TITLE = 'Agents'
const HISTORY_KEY = 'history'
const KEEP = 60

const runs = atom({ plugin: 'agent-monitor', key: 'runs' } as const, [])
const tick = atom({ plugin: 'agent-monitor', key: 'tick' } as const, 0)
const showAll = atom({ plugin: 'agent-monitor', key: 'showAll' } as const, false)

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

function base(path: unknown): string {
  return typeof path === 'string' ? path.split('/').filter(Boolean).pop() ?? path : ''
}

// One short line saying what a tool call is doing, for the "now" row.
function describeCall(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Bash':
      return `$ ${clip(s('command'), 70)}`
    case 'Read':
      return `reading ${base(input.file_path)}`
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `editing ${base(input.file_path ?? input.notebook_path)}`
    case 'Grep':
      return `searching "${clip(s('pattern'), 40)}"`
    case 'Glob':
      return `finding ${clip(s('pattern'), 40)}`
    case 'WebFetch':
      return `fetching ${clip(s('url'), 60)}`
    case 'WebSearch':
      return `searching web "${clip(s('query'), 40)}"`
    case 'Agent':
      return `spawning: ${clip(s('description'), 50)}`
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' › ') : tool
  }
}

function totalTokens(u: TurnUsage | undefined): number | null {
  if (!u) return null
  return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

function fmtTokens(n: number | null): string {
  if (n === null) return ''
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M tok` : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`
}

function fmtSecs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

function shortModel(model: string): string {
  const m = model.toLowerCase()
  for (const name of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(name)) return name
  return model
}

async function refreshStatus($: EngineInterface) {
  const list = await read($, runs)
  const running = list.filter(r => r.status === 'running').length
  $.ui.status(running > 0 ? `⚙ ${running} subagent${running === 1 ? '' : 's'} running` : undefined)
}

export const register: Register = on => {
  let opened = false
  let ticker: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: 'Open the subagent monitor: what each subagent is doing, its model, time and tokens',
      argumentHint: '[clear]',
    })
    const saved = await $.store.get(HISTORY_KEY)
    if (Array.isArray(saved)) {
      await update($, runs, list => (list.length > 0 ? list : (saved as AgentRun[]).slice(-KEEP)))
    }

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, runs, list => list.filter(r => r.status === 'running'))
      await $.store.set(HISTORY_KEY, [])
      return { text: 'Agent history cleared.' }
    }
    opened = true
    await $.ui.open({ id: PANE, title: TITLE })
    const list = await read($, runs)
    const running = list.filter(r => r.status === 'running').length

    return { text: `Agent monitor opened: ${running} running, ${list.length - running} finished.` }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) return started

    const run: AgentRun = {
      id: started.agentId,
      description: e.description || e.subagentType,
      type: e.subagentType,
      model: shortModel(started.model || e.model || e.parentModel),
      status: 'running',
      startedAt: await $.clock.now(),
      endedAt: null,
      tools: 0,
      doing: 'starting',
      tokens: null,
      summary: null,
    }
    await update($, runs, list => [...list.filter(r => r.id !== run.id), run].slice(-KEEP))

    if (!opened) {
      opened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }
    if (ticker === null) {
      ticker = $.clock.every(5000, () => {
        void (async () => {
          const list = await read($, runs)
          if (!list.some(r => r.status === 'running')) {
            ticker?.cancel()
            ticker = null
            return
          }
          await update($, tick, n => n + 1)
        })()
      })
    }
    await refreshStatus($)

    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const doing = describeCall(String(e.tool), e as unknown as Record<string, unknown>)
      void update($, runs, list =>
        list.some(r => r.id === agentId)
          ? list.map(r => (r.id === agentId ? { ...r, tools: r.tools + 1, doing } : r))
          : list,
      )
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const now = await $.clock.now()
      const status = e.isAborted ? 'stopped' : e.reason === 'error' || e.reason === 'refusal' ? 'failed' : 'done'
      const tokens = totalTokens(e.usage)
      const summary = e.answer ? clip(e.answer, 160) : null
      let isOurs = false
      await update($, runs, list =>
        list.map(r => {
          if (r.id !== agentId) return r
          isOurs = true
          return { ...r, status, endedAt: now, doing: null, summary, tokens: (r.tokens ?? 0) + (tokens ?? 0) || null }
        }),
      )
      if (isOurs) {
        const list = await read($, runs)
        await $.store.set(HISTORY_KEY, list.filter(r => r.status !== 'running').slice(-KEEP))
        await refreshStatus($)
        if (status === 'failed') $.ui.toast(`Subagent failed: ${clip(list.find(r => r.id === agentId)?.description ?? '', 50)}`)
      }
    }

    return next(e)
  })


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tick)
    const now = await $.clock.now()
    const list = await read($, runs)
    const isAll = await read($, showAll)
    const running = list.filter(r => r.status === 'running')
    const finished = list.filter(r => r.status !== 'running').reverse()
    const shown = isAll ? finished : finished.slice(0, 8)
    const width = Math.max(20, e.props.bodyColumns ?? 40)
    const mark = { done: '✓', failed: '✗', stopped: '■', running: '●' } as const
    const tone = { done: 'success', failed: 'error', stopped: 'warning', running: 'claude' } as const

    const row = (r: AgentRun) => (
      <Box key={`r-${r.id}`} flexDirection="column" marginBottom={1}>
        <Button key={`v-${r.id}`} plain onPress={() => void $.ui.view({ agentId: r.id })}>
          <Text color={tone[r.status]}>{mark[r.status]} </Text>
          {clip(r.description, width - 4)}
        </Button>
        <Text dimColor wrap="truncate">
          {'  '}
          {r.type} · {r.model} · {fmtSecs((r.endedAt ?? now) - r.startedAt)} · {r.tools} tools
          {r.tokens ? ` · ${fmtTokens(r.tokens)}` : ''}
        </Text>
        {r.doing && (
          <Text color="suggestion" wrap="truncate">
            {'  now: '}
            {r.doing}
          </Text>
        )}
        {r.summary && r.status !== 'running' && (
          <Text dimColor wrap="truncate">
            {'  → '}
            {r.summary}
          </Text>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold>Running ({running.length})</Text>
        {running.length === 0 && <Text dimColor>No subagents running.</Text>}
        {running.map(row)}
        <Box marginTop={1}>
          <Text bold>Finished ({finished.length})</Text>
        </Box>
        {finished.length === 0 && <Text dimColor>Nothing yet. Subagents appear here as Claude spawns them.</Text>}
        {shown.map(row)}
        <Box flexDirection="row" gap={1}>
          {finished.length > 8 && (
            <Button key="all" label={isAll ? 'Show fewer' : `Show all ${finished.length}`} onPress={() => void update($, showAll, v => !v)} />
          )}
          {finished.length > 0 && (
            <Button
              key="clear"
              label="Clear history"
              onPress={async () => {
                await update($, runs, l => l.filter(r => r.status === 'running'))
                await $.store.set(HISTORY_KEY, [])
              }}
            />
          )}
        </Box>
        <Text dimColor>Press a row to open that agent's transcript.</Text>
      </Box>
    )
  })
}
