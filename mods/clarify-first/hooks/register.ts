import type { EngineInterface, Register } from 'claude-code'

type Mode = 'on' | 'off' | 'always'

// Origins that are a person typing: the terminal, Remote Control (phone), an app host.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const BUILD = /\b(build|implement|design|architect|create|develop|set ?up|migrate|refactor|integrate|automate|launch|plan|roadmap|strategy|optimi[sz]e|scale|overhaul|rewrite)\b/i
const ARTIFACT = /\b(app|system|service|pipeline|api|backend|frontend|platform|feature|architecture|database|schema|workflow|website|dashboard|product|business|model|course|curriculum)\b/i
const DEEP = /\b(why|how should|trade-?offs?|best (way|approach|practice)|compare|versus|vs\.?|pros and cons|should (i|we)|which (one|approach|option)|evaluate|what would it take|long[- ]term)\b/i
const VAGUE = /\b(something like|some kind of|etc\.?|whatever|kind of|sort of|maybe|not sure|ideas?)\b/i
const TRIVIAL = /^(fix (the |this )?typo|rename|format|lint|run |what (is|are|does) \S+\??$|show |list |open |commit|push|thanks|ok\b|yes\b|no\b|continue|go ahead|explain this (line|error))/i

// Zero-token score: 3 or more is complex, 2 is borderline, less is everyday.
function score(text: string): number {
  let s = 0
  if (text.length > 400) s += 2
  else if (text.length > 150) s += 1
  if (BUILD.test(text) && ARTIFACT.test(text)) s += 2
  else if (BUILD.test(text)) s += 1
  if (DEEP.test(text)) s += 1
  if (VAGUE.test(text)) s += 1
  if ((text.match(/[.?!](\s|$)/g)?.length ?? 0) >= 3 || /\n\s*([-*•]|\d+\.)\s/.test(text)) s += 1
  if (/```|\bat .+:\d+:\d+|Traceback|Error:/.test(text)) s -= 1
  if (TRIVIAL.test(text.trim()) || text.length < 40) s -= 3
  return s
}

function brief(max: number): string {
  return [
    'clarify-first: this request looks complex. Before doing the work:',
    '1. Do a quick, cheap look (repo files, earlier messages) for anything you can learn yourself. Never ask what you can find or confidently infer.',
    `2. If missing information would materially change the result (goal, scope, constraints, audience, success criteria, environment, priorities, edge cases), call AskUserQuestion ONCE with up to ${max} questions. Ask only the questions whose answers would change what you produce. Make them multiple choice, recommended option first and marked "(Recommended)".`,
    '3. If nothing material is missing, skip the questions and proceed.',
    '4. After the answers, state the agreed spec in at most 3 lines, do the work to it, and before finishing check the result against it.',
  ].join('\n')
}

async function classify($: EngineInterface, text: string): Promise<boolean> {
  const label = await $.model
    .classify(
      `Does answering this well need clarifying questions about goals, scope or constraints, because it is a complex task or a deep, open-ended question (not a routine or factual one)?\n\n${text.slice(0, 2000)}`,
      ['complex', 'routine'],
    )
    .catch(() => undefined)
  return label === 'complex'
}

export const register: Register = (on, options) => {
  const detector = String(options.detector ?? 'hybrid')
  const max = Math.min(4, Math.max(1, Number(options.maxQuestions ?? 4)))
  let mode: Mode = 'on'
  let asked = 0
  let skipped = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'clarify',
      description: 'Clarifying questions before complex tasks: /clarify on | off | always | now <task> | status',
      argumentHint: '[on | off | always | now <task> | status]',
    })
    const saved = await $.store.get('mode')
    if (saved === 'on' || saved === 'off' || saved === 'always') mode = saved

    return next(e)
  })

  on('command.run', { command: 'clarify' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', ...rest] = args.split(/\s+/)
    if (word === 'on' || word === 'off' || word === 'always') {
      mode = word
      await $.store.set('mode', word)
      const said = { on: 'Questions only on complex tasks and deep questions.', off: 'Off: no clarifying questions.', always: 'Questions before every task.' }
      return { text: `clarify-first: ${said[word]}` }
    }
    if (word === 'now' && rest.length > 0) {
      const task = rest.join(' ')
      $.clock.after(100, () => void $.prompt.submit({ text: task, asUser: true }))
      return { text: 'Asking clarifying questions first.', context: [brief(max)] }
    }

    return { text: `clarify-first is ${mode} (detector: ${detector}). This session: ${asked} prompt${asked === 1 ? '' : 's'} got questions, ${skipped} passed straight through.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (mode === 'off' || e.command || e.isMeta || !PERSON.has(e.origin.kind) || e.turnId !== undefined) return next(e)
    const text = e.text.trim()

    let isComplex: boolean
    if (mode === 'always') isComplex = text.length >= 20
    else if (detector === 'model') isComplex = text.length > 60 && (await classify($, text))
    else {
      const s = score(text)
      isComplex = s >= 3 || (s === 2 && detector === 'hybrid' && (await classify($, text)))
    }

    if (!isComplex) {
      skipped += 1
      return next(e)
    }
    asked += 1

    return next({ ...e, context: [...(e.context ?? []), brief(max)] })
  }).catch(($, e, next) => next(e))
}
