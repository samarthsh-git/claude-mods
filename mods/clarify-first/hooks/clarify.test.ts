import { expect, mock, test } from 'claude-code/testing'

const SESSION = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('complex prompts get the brief, everyday ones pass untouched', async ($, on) => {
  mock.store(on)
  const contexts: (readonly string[] | undefined)[] = []
  let classified = 0
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('model.classify', () => (classified++, { value: 'routine' }) as never)
  on('prompt.submit', (_, e) => (contexts.push(e.context), { text: e.text }))

  await $.session.start(SESSION)
  const ask = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await ask('Build a multi-tenant SaaS backend with billing and an admin dashboard. It should scale. Not sure about the database.')
  await ask('fix the typo in README')
  await ask('what is a mutex?')

  expect(contexts[0]?.[0]).toContain('AskUserQuestion')
  expect(contexts[1]).toBeUndefined()
  expect(contexts[2]).toBeUndefined()
  expect(classified).toBe(0)
})
