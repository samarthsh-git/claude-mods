import { expect, mock, test } from 'claude-code/testing'

const SESSION = { cwd: '/', surface: 'desktop', isInteractive: true } as const

test('suggests an installed mod, sets focus, and makes a macro on the third repeat', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const toasts: string[] = []
  const registered: string[] = []
  const ran: string[] = []
  on('command.register', (_, e) => (registered.push(e.name), { value: { command: e.name } }))
  on('command.list', () => ({ value: [{ name: 'tokens', description: '', source: 'plugin' }, { name: 'aim', description: '', source: 'plugin' }] }) as never)
  on('command.run', (_, e) => (ran.push(`${e.command} ${e.args}`), { text: 'ok' }))
  on('ui.toast', (_, e) => (toasts.push(String((e as { text: string }).text)), { value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start(SESSION)
  const say = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await say('Build the payment retry logic for failed UPI transactions')
  await say('why is my token usage so high this week?')
  for (let i = 0; i < 3; i++) await say('run the test suite and fix any failures')
  await clock.advance(200)

  expect(ran).toContain('aim auto Build the payment retry logic for failed UPI transactions')
  expect(toasts.some(t => t.includes('/tokens'))).toBe(true)
  expect(registered).toContain('run-test')
  expect(toasts.some(t => t.includes('/run-test'))).toBe(true)
})
