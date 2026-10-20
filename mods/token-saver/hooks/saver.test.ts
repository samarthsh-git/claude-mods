import { expect, mock, test } from 'claude-code/testing'

const SESSION = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const spawn = (subagentType: string, model?: string) => ({
  tool_use_id: 't', prompt: 'p', description: 'd', subagentType, model,
  provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5',
  background: true, fork: false,
})

test('routes an Explore subagent to haiku and leaves others alone', async ($, on) => {
  mock.clock(on)
  const models: (string | undefined)[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, percent: 10 }, rateLimits: [] } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', (_, e) => (models.push(e.model), { model: e.model ?? e.parentModel, agentId: `a${models.length}` }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawn('Explore'))
  await $.agent.spawn(spawn('general-purpose'))
  await $.agent.spawn(spawn('Explore', 'opus'))
  expect(models).toEqual(['haiku', undefined, 'opus'])
})

test('adds the lean rules to the system prompt', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  expect(r.sections.map(s => s.id)).toEqual(['intro', 'token-saver:lean'])
})

test('refuses one duplicate read of an unchanged file, then lets a retry through', async ($, on) => {
  mock.clock(on)
  let reads = 0
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 5, isLink: false } }) as never)
  on('tool.call', () => (reads++, { result: {} }) as never)

  const call = { tool: 'Read', file_path: '/a.ts' } as never
  await $.tool.call(call)
  const second = await $.tool.call(call)
  const third = await $.tool.call(call)
  expect(second.deny).toContain('already read')
  expect(third.deny).toBeUndefined()
  expect(reads).toBe(2)
})
