import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TokenTally } from '../types'

const EMPTY: TokenTally = {
  turns: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  subagentTokens: 0,
  routed: 0,
  dedupedReads: 0,
}
const tally = atom({ plugin: 'token-saver', key: 'tally' } as const, EMPTY)

const LEAN_RULES = [
  'Token discipline (accuracy first, then brevity):',
  '- Answer directly. No preamble, no restating the request, no closing recap of what you just did unless asked.',
  '- Locate before you read: Grep/Glob first, then Read only the relevant range (offset/limit) of large files.',
  '- Do not re-read a file that is already in your context and has not changed.',
  '- Put independent tool calls in one message so they run in parallel.',
  '- Hand broad, read-heavy searches to an Explore subagent so raw output stays out of this context.',
  '- Prefer Edit over rewriting whole files; show only changed code in replies.',
  '- Never trade correctness for brevity: verify with tools instead of guessing.',
].join('\n')

// Built-in agent types whose work is search and lookup: cheap models do it as well.
const LOOKUP_AGENTS = new Set(['Explore', 'claude-code-guide', 'statusline-setup'])
const ROUTINE_AGENTS = new Set(['general-purpose', 'Plan'])

const TRIVIAL = /^(rename|fix (the )?typo|format|lint|add (a )?comment|what (is|does)|explain|list|show|summari[sz]e|commit|bump|translate)\b/i
const HARD = /\b(architect|design|race condition|deadlock|memory leak|security|vulnerab|refactor (the )?(whole|entire)|migrat|concurren|why (does|is) .* (fail|crash|slow))/i

function tier(model: string): 'haiku' | 'sonnet' | 'opus' | 'other' {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus') || m.includes('fable')) return 'opus'
  return 'other'
}

function k(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

async function refreshHud($: EngineInterface) {
  const u = await $.session.usage()
  const parts: string[] = []
  if (u.context.percent !== undefined) parts.push(`ctx ${u.context.percent}%`)
  if (u.cost) parts.push(`$${u.cost.usd.toFixed(2)}`)
  for (const r of u.rateLimits) {
    const label = r.kind === 'five_hour' ? '5h' : r.kind === 'seven_day' ? '7d' : r.kind
    parts.push(`${label} ${r.percentUsed}%`)
  }
  $.ui.status(parts.length > 0 ? parts.join(' · ') : undefined)
  return u
}

export const register: Register = (on, options) => {
  const routing = String(options.routing ?? 'balanced')
  const isLean = options.leanRules !== false
  const isDedupe = options.dedupeReads !== false
  const isAdvisor = options.advisor !== false

  // file reads per context (main loop or subagent): path+range -> mtime
  const seen = new Map<string, number>()
  // a read refused once is let through when asked again
  const refused = new Set<string>()
  let warnedContext = false
  let warnedLimit = false
  let lastAdvice = -Infinity

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: 'Token report: spend, cache hit rate, subagent share, what token-saver saved, and what to change',
    })
    await refreshHud($)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    // Compaction drops file contents from context: they may be read again.
    seen.clear()
    refused.clear()
    warnedContext = false

    return next(e)
   }).catch(($, e, next) => next(e))

  if (isLean) {
    on('prompt.compose', async ($, e, next) => {
      const composed = await next(e)

      return { sections: [...composed.sections, { id: 'token-saver:lean', text: LEAN_RULES, scope: 'session' as const }] }
    }).catch(($, e, next) => next(e))
  }

  if (routing !== 'off') {
    on('agent.spawn', async ($, e, next) => {
      const isBuiltin = e.provider.plugin === 'engine'
      const isFixed = e.model !== undefined || e.fork || e.resume !== undefined || e.workflow !== undefined || e.isTeammate
      if (!isBuiltin || isFixed) return next(e)

      const parent = tier(e.parentModel)
      let model: string | undefined
      if (LOOKUP_AGENTS.has(e.subagentType) && parent !== 'haiku') model = 'haiku'
      else if (routing === 'aggressive' && ROUTINE_AGENTS.has(e.subagentType) && parent === 'opus') model = 'sonnet'
      if (model === undefined) return next(e)

      const started = await next({ ...e, model })
      if (started.deny === undefined) await update($, tally, t => ({ ...t, routed: t.routed + 1 }))

      return started
    }).catch(($, e, next) => next(e))
  }

  if (isDedupe) {
    on('tool.call', { tool: 'Read' }, async ($, e, next) => {
      const key = `${e.agentId ?? 'main'}|${e.file_path}|${e.offset ?? ''}|${e.limit ?? ''}|${e.pages ?? ''}`
      const stat = await $.fs.stat(e.file_path).catch(() => null)
      const mtime = stat?.mtimeMs
      if (mtime !== undefined && seen.get(key) === mtime && !refused.has(key)) {
        refused.add(key)
        await update($, tally, t => ({ ...t, dedupedReads: t.dedupedReads + 1 }))

        return {
          deny: `token-saver: ${e.file_path} was already read with this range in this context and is unchanged on disk. Use the copy you have. If it is no longer in your context, repeat this exact call and it will go through.`,
        }
      }
      refused.delete(key)
      const ran = await next(e)
      if (mtime !== undefined && ran.deny === undefined && ran.isError !== true) seen.set(key, mtime)

      return ran
    }).catch(($, e, next) => next(e))
  }

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) {
      const total = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, tally, t =>
        e.agentId !== undefined
          ? { ...t, subagentTokens: t.subagentTokens + total }
          : {
              ...t,
              turns: t.turns + 1,
              input: t.input + u.input_tokens,
              output: t.output + u.output_tokens,
              cacheRead: t.cacheRead + u.cache_read_input_tokens,
              cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
            },
      )
    }
    if (e.agentId === undefined) {
      const usage = await refreshHud($)
      const pct = usage.context.percent ?? 0
      if (pct >= 70 && !warnedContext) {
        warnedContext = true
        $.ui.toast(`Context ${pct}% full: every turn now resends it. /compact keeps the thread, /clear starts a new task cheaply.`)
      }
      const limit = usage.rateLimits.find(r => r.percentUsed >= 80)
      if (limit && !warnedLimit) {
        warnedLimit = true
        $.ui.toast(`${limit.kind} usage at ${limit.percentUsed}%. Consider /model sonnet for routine work until it resets.`)
      }
    }

    return next(e)
  })

  if (isAdvisor) {
    on('prompt.submit', async ($, e, next) => {
      if (e.command || e.isMeta || e.origin.kind !== 'composer') return next(e)
      const now = await $.clock.now()
      if (now - lastAdvice < 15 * 60_000) return next(e)

      const model = tier(await $.session.model())
      const text = e.text.trim()
      if (model === 'opus' && text.length < 160 && TRIVIAL.test(text)) {
        lastAdvice = now
        $.ui.toast('Simple ask on an Opus-class model. /model sonnet (or haiku) does this for a fraction of the tokens.')
      } else if (model === 'haiku' && HARD.test(text)) {
        lastAdvice = now
        $.ui.toast('This looks like hard reasoning. /model opus (or sonnet) is likely more accurate here.')
      }

      return next(e)
    }).catch(($, e, next) => next(e))
  }

  on('command.run', { command: 'tokens' }, async $ => {
    const t = await read($, tally)
    const u = await refreshHud($)
    const model = await $.session.model()
    const prompt = t.input + t.cacheRead + t.cacheWrite
    const hit = prompt > 0 ? Math.round((t.cacheRead / prompt) * 100) : 0
    const main = prompt + t.output
    const sub = main + t.subagentTokens > 0 ? Math.round((t.subagentTokens / (main + t.subagentTokens)) * 100) : 0
    const tips: string[] = []
    if ((u.context.percent ?? 0) >= 60) tips.push('Context is past 60%: /compact, or /clear before the next unrelated task.')
    if (prompt > 50_000 && hit < 60) tips.push('Cache hit rate is low: avoid switching model mid-thread and long idle gaps (the cache lapses after ~5 min).')
    if (tier(model) === 'opus' && t.routed === 0 && t.turns > 5) tips.push('No subagent was routed yet: ask Claude to delegate searches to Explore subagents.')
    if (t.turns > 0 && t.output / t.turns > 3000) tips.push('Replies are long on average: ask for diffs or bullet answers.')

    const lines = [
      `Model ${model} · ${t.turns} turns · ${u.cost ? `$${u.cost.usd.toFixed(2)}` : 'cost n/a'} · context ${u.context.percent ?? '?'}%`,
      `Main loop: ${k(t.input)} fresh in, ${k(t.cacheRead)} cache read, ${k(t.cacheWrite)} cache write, ${k(t.output)} out (cache hit ${hit}%)`,
      `Subagents: ${k(t.subagentTokens)} tokens (${sub}% of all)`,
      `token-saver: ${t.routed} subagent${t.routed === 1 ? '' : 's'} routed to a cheaper model, ${t.dedupedReads} duplicate read${t.dedupedReads === 1 ? '' : 's'} stopped`,
      ...u.rateLimits.map(r => `Limit ${r.kind}: ${r.percentUsed}%${r.resetsAt ? `, resets ${r.resetsAt}` : ''}`),
      ...(tips.length > 0 ? ['', ...tips.map(x => `• ${x}`)] : []),
    ]

    return { text: lines.join('\n') }
  })
}
