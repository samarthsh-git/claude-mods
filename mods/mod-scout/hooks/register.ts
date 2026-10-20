import type { EngineInterface, Register } from 'claude-code'

type Macro = { name: string; text: string; createdAt: number }
type Count = { n: number; text: string; at: number }
type Rule = { id: string; command: string; test: RegExp; tip: string }

// Origins that are a person typing: the terminal, Remote Control (phone), an app host.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

// Each rule fires only when its command is installed, at most once a session.
const RULES: readonly Rule[] = [
  { id: 'tokens', command: 'tokens', test: /\b(tokens?|cost|spend|usage|limit|expensive|cheaper|quota)\b/i, tip: '/tokens shows where tokens go and what to change' },
  { id: 'subagents', command: 'subagents', test: /\b(sub-?agents?|agents? (are|is) (doing|running)|background (jobs?|agents?))\b/i, tip: '/subagents shows every subagent and what it is doing now' },
  { id: 'todo', command: 'todo', test: /\b(remind me|don'?t forget|to-?do|later i (need|have) to|note to self)\b/i, tip: '/todo <text> keeps it on your list across sessions' },
  { id: 'eod', command: 'eod', test: /\b(stand-?up|end of (the )?day|what did i (do|get done)|daily (summary|report)|status update)\b/i, tip: '/eod prints today\'s work log for free' },
  { id: 'pickup', command: 'pickup', test: /\b(where (was i|did we leave)|pick up|continue (from )?(yesterday|last time)|resume (the|my) work)\b/i, tip: '/pickup continues from the last /handoff note' },
  { id: 'handoff', command: 'handoff', test: /\b(wrap(ping)? up|calling it a day|done for (today|the day)|stop(ping)? for now|tomorrow i)\b/i, tip: '/handoff saves where you are so the next session resumes exactly here' },
  { id: 'podium', command: 'podium', test: /\b(codex|gemini|muse|other agents?|second opinion|cross-?review)\b/i, tip: '/podium hands the job to another agent CLI and tracks it' },
  { id: 'grounded', command: 'grounded', test: /\b(best practices?|ci gate|repo (structure|hygiene)|engineering (standards|practices)|agents\.md|claude\.md)\b/i, tip: '/grounded lists practices that fit this repo, with sources' },
  { id: 'clarify', command: 'clarify', test: /\b(ask me (questions|first)|clarify|before you start)\b/i, tip: '/clarify now <task> makes Claude ask its questions first' },
]

const STOP = new Set('a an the to of in on for and or but is are be it this that with my me i you we please can could would should do make just then also from at by as so what how'.split(' '))

function normalize(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/[^\w#\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function slugOf(text: string, taken: ReadonlySet<string>): string {
  const words = normalize(text).replace(/#/g, '').split(' ').filter(w => w.length > 1 && !STOP.has(w))
  const base = (words.slice(0, 2).join('-') || 'macro').slice(0, 24)
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
  return name
}

// Independent items in one prompt: 3+ numbered or bulleted lines.
function listCount(text: string): number {
  return text.match(/^\s*([-*•]|\d+[.)])\s+\S/gm)?.length ?? 0
}

const TASK = /\b(build|implement|add|create|fix|refactor|migrate|write|design|set ?up|debug|optimi[sz]e|integrate|ship|deploy)\b/i

async function commandNames($: EngineInterface): Promise<Set<string>> {
  const list = await $.command.list().catch(() => [])
  return new Set(list.map(c => c.name))
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

function buildPrompt(idea: string): string {
  return [
    `Build a Claude Code mod for this: ${idea}`,
    'Load the plugin-authoring skill and follow it: write the mod in this session\'s mods folder, then validate, type-check and test it.',
    'Constraints: zero model tokens at run time wherever possible (no model calls in hooks unless the feature needs one, and then the small fast model);',
    'never rewrite or trim prompts, system prompt or tool results in a way that could lower answer quality; prefer suggestions over silent actions.',
    'Check the installed commands first so it does not duplicate an existing mod. Finish with 3 lines: what it does, its commands, its cost.',
  ].join(' ')
}

async function registerMacro($: EngineInterface, m: Macro) {
  await $.command.register({ name: m.name, description: `Macro: ${clip(m.text, 90)}` })
}

export const register: Register = (on, options) => {
  const isAutoMacros = options.autoMacros !== false
  const isAutoFocus = options.autoFocus !== false
  let isOn = true
  let macros: Macro[] = []
  let installed = new Set<string>()
  const shown = new Set<string>()
  const recent: string[] = []
  let lastToast = -Infinity
  let isFocusDone = false

  function remember(line: string) {
    recent.push(line)
    if (recent.length > 10) recent.shift()
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'scout',
      description: 'mod-scout: suggestions so far, your macros, and /scout build <idea> to have Claude make a new mod',
      argumentHint: '[build <idea> | macros | rm <macro> | on | off]',
    })
    isOn = (await $.store.get('isOn')) !== false
    const saved = await $.store.get('macros')
    macros = Array.isArray(saved) ? (saved as Macro[]) : []
    installed = await commandNames($)
    for (const m of macros) if (!installed.has(m.name)) await registerMacro($, m).catch(() => undefined)

    return next(e)
  })

  on('command.run', async ($, e, next) => {
    const macro = macros.find(m => m.name === e.command)
    if (macro === undefined) return next(e)
    const extra = e.args.trim()
    const text = extra ? `${macro.text}\n\n${extra}` : macro.text
    $.clock.after(50, () => void $.prompt.submit({ text, asUser: true }))

    return { text: `/${macro.name} sent its prompt.` }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'scout' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', ...rest] = args.split(/\s+/)
    if (word === 'build' && rest.length > 0) {
      const idea = rest.join(' ')
      $.clock.after(50, () => void $.prompt.submit({ text: buildPrompt(idea), asUser: true }))
      return { text: `Asking Claude to build a mod for: ${idea}` }
    }
    if (word === 'on' || word === 'off') {
      isOn = word === 'on'
      await $.store.set('isOn', isOn)
      return { text: `mod-scout ${word}.` }
    }
    if (word === 'rm' && rest[0]) {
      const name = rest[0].replace(/^\//, '')
      if (!macros.some(m => m.name === name)) return { text: `No macro /${name}.` }
      macros = macros.filter(m => m.name !== name)
      await $.store.set('macros', macros)
      return { text: `Removed /${name}. It disappears from the command list next session.` }
    }
    const lines = [
      `mod-scout is ${isOn ? 'on' : 'off'}.`,
      `Macros (${macros.length}): ${macros.map(m => `/${m.name}`).join(', ') || 'none yet. Send the same prompt 3 times and one is made.'}`,
      `Recent suggestions: ${recent.length === 0 ? 'none' : ''}`,
      ...recent.map(r => `• ${r}`),
      'Make a new mod: /scout build <what it should do>',
    ]

    return { text: lines.join('\n') }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isOn || e.command || e.isMeta || !PERSON.has(e.origin.kind)) return next(e)
    const text = e.text.trim()
    const now = await $.clock.now()
    // Other mods register their commands as they start: read the list fresh.
    installed = new Set([...(await commandNames($)), ...macros.map(m => m.name)])

    // 1. The one rule that fits, if its mod is installed and it was not shown yet.
    const rule = RULES.find(r => !shown.has(r.id) && installed.has(r.command) && r.test.test(text))
    let tip: string | undefined = rule?.tip
    if (rule) shown.add(rule.id)
    if (!tip && !shown.has('inbox') && installed.has('inbox') && listCount(text) >= 3) {
      shown.add('inbox')
      tip = 'Several independent tasks: /inbox each one, then Send, and they run in parallel subagents'
    }
    if (tip) {
      remember(tip)
      if (now - lastToast > 60_000) {
        lastToast = now
        $.ui.toast(`💡 ${tip}`)
      }
    }

    // 2. The session's first real task becomes the focus goal, when none is set.
    if (isAutoFocus && !isFocusDone && installed.has('aim') && TASK.test(text) && text.length >= 30 && text.length <= 600) {
      isFocusDone = true
      const goal = clip(text.split(/(?<=[.?!])\s|\n/)[0] ?? text, 70)
      $.clock.after(50, () => void $.command.run({ command: 'aim', args: `auto ${goal}` }).catch(() => undefined))
    }

    // 3. A prompt sent for the third time becomes a slash command.
    if (isAutoMacros && text.length >= 15 && text.length <= 1500) {
      const key = normalize(text)
      const counts = ((await $.store.get('counts')) ?? {}) as Record<string, Count>
      const seen = counts[key]
      counts[key] = { n: (seen?.n ?? 0) + 1, text, at: now }
      const keys = Object.keys(counts)
      if (keys.length > 300) {
        keys.sort((a, b) => (counts[a]?.at ?? 0) - (counts[b]?.at ?? 0))
        for (const old of keys.slice(0, keys.length - 300)) delete counts[old]
      }
      await $.store.set('counts', counts)
      if (counts[key]?.n === 3 && !macros.some(m => normalize(m.text) === key)) {
        const taken = new Set([...installed, ...macros.map(m => m.name)])
        const macro: Macro = { name: slugOf(text, taken), text, createdAt: now }
        macros = [...macros, macro]
        await $.store.set('macros', macros)
        installed.add(macro.name)
        $.clock.after(50, () => void registerMacro($, macro).catch(() => undefined))
        remember(`Made /${macro.name} for a prompt you sent 3 times`)
        $.ui.toast(`⚡ You sent this 3 times: /${macro.name} now sends it. /scout rm ${macro.name} undoes it.`)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
