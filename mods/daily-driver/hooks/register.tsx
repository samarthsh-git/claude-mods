import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DayLog, Focus } from '../types'

const focus = atom({ plugin: 'daily-driver', key: 'focus' } as const, null)
const today = atom({ plugin: 'daily-driver', key: 'today' } as const, null)
const isBandHidden = atom({ plugin: 'daily-driver', key: 'isBandHidden' } as const, false)

const HANDOFF = '.claude/handoff.md'
const TESTS = /\b((npm|pnpm|yarn|bun)( run)? test|pytest|go test|cargo test|jest|vitest|mvn test|gradle test|dotnet test|rspec|phpunit)\b/
const COMMIT = /\bgit commit\b/
const MSG = /-m\s+(?:"([^"]+)"|'([^']+)')/

function dayOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function blank(day: string): DayLog {
  return { day, prompts: 0, turns: 0, activeMs: 0, files: [], commits: [], testsPassed: 0, testsFailed: 0, agents: 0, goalsDone: [] }
}

function dur(ms: number): string {
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

// Applies a change to today's log, rolling over at midnight, and saves it.
async function log($: EngineInterface, fn: (d: DayLog) => DayLog) {
  const day = dayOf(await $.clock.now())
  let current = await read($, today)
  if (current === null || current.day !== day) {
    const saved = await $.store.get(`log:${day}`)
    current = saved && typeof saved === 'object' ? { ...blank(day), ...(saved as DayLog) } : blank(day)
  }
  const next = fn(current)
  await update($, today, () => next)
  await $.store.set(`log:${day}`, next)
}

function handoffPrompt(): string {
  return [
    `Write a handoff note to ${HANDOFF} (create the folder if needed, overwrite the file) so a fresh session can resume this work with no other context.`,
    'Keep it under 40 lines, in this order: Goal; Done so far (with file paths); Current state (what works, what is broken, failing tests);',
    'Next steps (numbered, concrete); Open questions and decisions; Gotchas learned. No prose padding.',
    'Reply with one line confirming it is written.',
  ].join(' ')
}

export const register: Register = (on, options) => {
  const notifyAfterMs = Number(options.notifyAfterSeconds ?? 60) * 1000
  let cwd = ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'aim', description: 'Set the goal you are working on (shown above the prompt); /aim done marks it finished', argumentHint: '[goal | done]' })
    await $.command.register({ name: 'eod', description: "Today's work log: time, files, commits, tests, subagents, goals done. Costs no tokens", argumentHint: '[yesterday]' })
    await $.command.register({ name: 'handoff', description: `Have Claude write ${HANDOFF} so the next session resumes exactly here` })
    await $.command.register({ name: 'pickup', description: `Continue from ${HANDOFF} left by an earlier session` })
    const saved = await $.store.get(`focus:${cwd}`)
    if (saved && typeof saved === 'object') await update($, focus, () => saved as Focus)
    await log($, d => d)
    if (await $.fs.exists(`${cwd}/${HANDOFF}`).catch(() => false)) {
      $.ui.toast(`A handoff note from an earlier session is in ${HANDOFF}. /pickup continues from it.`)
    }

    return next(e)
  })

  on('command.run', { command: 'aim' }, async ($, e) => {
    const args = e.args.trim()
    const current = await read($, focus)
    if (args === '' || args === 'done') {
      if (current === null) return { text: 'No focus set. /aim <goal> sets one.' }
      if (args === 'done') await log($, d => ({ ...d, goalsDone: [...d.goalsDone, current.goal] }))
      await update($, focus, () => null)
      await $.store.delete(`focus:${cwd}`)
      return { text: args === 'done' ? `Done: ${current.goal}` : `Focus cleared (was: ${current.goal}).` }
    }
    const isAuto = args.startsWith('auto ')
    if (isAuto && current !== null) return { text: `Focus kept: ${current.goal}` }
    const goal = isAuto ? args.slice(5).trim() : args
    const next: Focus = { goal, setAt: await $.clock.now() }
    await update($, focus, () => next)
    await update($, isBandHidden, () => false)
    await $.store.set(`focus:${cwd}`, next)

    return { text: `Focus: ${goal}` }
  })

  on('command.run', { command: 'eod' }, async ($, e) => {
    const now = await $.clock.now()
    const day = e.args.trim() === 'yesterday' ? dayOf(now - 86_400_000) : dayOf(now)
    const saved = await $.store.get(`log:${day}`)
    const d: DayLog = day === dayOf(now) ? ((await read($, today)) ?? blank(day)) : saved ? { ...blank(day), ...(saved as DayLog) } : blank(day)
    const f = await read($, focus)
    const lines = [
      `Work log ${d.day}: ${dur(d.activeMs)} of Claude time over ${d.turns} turns from ${d.prompts} prompts`,
      `Goals done: ${d.goalsDone.length === 0 ? 'none marked (/aim done)' : d.goalsDone.join('; ')}`,
      ...(f ? [`In progress: ${f.goal}`] : []),
      `Files changed (${d.files.length}): ${d.files.slice(-15).map(p => p.replace(`${cwd}/`, '')).join(', ') || 'none'}`,
      `Commits (${d.commits.length}): ${d.commits.slice(-10).join('; ') || 'none'}`,
      `Test runs: ${d.testsPassed} passed, ${d.testsFailed} failed · Subagents: ${d.agents}`,
    ]

    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    $.clock.after(100, () => void $.prompt.submit({ text: handoffPrompt() }))
    return { text: `Asking Claude to write ${HANDOFF}.` }
  })

  on('command.run', { command: 'pickup' }, async $ => {
    if (!(await $.fs.exists(`${cwd}/${HANDOFF}`).catch(() => false))) return { text: `No ${HANDOFF} here. /handoff writes one.` }
    $.clock.after(100, () => void $.prompt.submit({ text: `Read ${HANDOFF} and continue the work from its Next steps. Confirm the current state with a quick check before changing anything.` }))
    return { text: `Resuming from ${HANDOFF}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta) await log($, d => ({ ...d, prompts: d.prompts + 1 }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined) await log($, d => ({ ...d, agents: d.agents + 1 }))
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const isOk = ran.isError !== true
    if ((e.tool === 'Edit' || e.tool === 'Write') && isOk) {
      const path = e.file_path
      await log($, d => (d.files.includes(path) ? d : { ...d, files: [...d.files, path].slice(-200) }))
    } else if (e.tool === 'Bash') {
      const cmd = e.command
      if (COMMIT.test(cmd) && isOk) {
        const m = MSG.exec(cmd)
        const msg = clip(m?.[1] ?? m?.[2] ?? 'commit', 70)
        await log($, d => ({ ...d, commits: [...d.commits, msg].slice(-100) }))
      }
      if (TESTS.test(cmd)) await log($, d => (isOk ? { ...d, testsPassed: d.testsPassed + 1 } : { ...d, testsFailed: d.testsFailed + 1 }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await log($, d => ({ ...d, turns: d.turns + 1, activeMs: d.activeMs + e.durationMs }))
      if (notifyAfterMs > 0 && e.durationMs >= notifyAfterMs && !e.isAborted) {
        const f = await read($, focus)
        void $.ui.notify(clip(e.answer || 'Turn finished.', 140), { title: `Claude finished (${dur(e.durationMs)})${f ? `: ${clip(f.goal, 40)}` : ''}` })
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, focus)
    if (f === null || e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const d = await read($, today)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, (e.props.bodyColumns ?? 80) - 24)

    return (
      <Box flexDirection="row" gap={1}>
        <Text color="claude">◎</Text>
        <Text bold wrap="truncate">{clip(f.goal, Math.floor(width * 0.6))}</Text>
        <Text dimColor wrap="truncate">
          {dur(now - f.setAt)} on it{d ? ` · ${d.files.length} files · ${d.commits.length} commits today` : ''}
        </Text>
        <Button
          key="done"
          label="Done"
          onPress={async () => {
            await log($, x => ({ ...x, goalsDone: [...x.goalsDone, f.goal] }))
            await update($, focus, () => null)
            await $.store.delete(`focus:${cwd}`)
            $.ui.toast(`Done: ${f.goal}`)
          }}
        />
        <Button key="hide" plain dimColor label="✕" onPress={() => void update($, isBandHidden, () => true)} />
      </Box>
    )
  })
}
