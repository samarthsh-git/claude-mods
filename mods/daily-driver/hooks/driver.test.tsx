import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'daily-driver',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { bodyColumns: 100, hasSurvey: false, view: {} },
} as const

test('aim shows in the band and edits and commits reach /eod', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: 'engine' }))
  on('fs.exists', () => ({ value: false }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }) as never)

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'aim', args: 'ship login page' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/login.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "add login form"' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect(await ui.find({ type: 'Text', text: /ship login page/ })).toBeDefined()
    await ui.unmount()
  }

  const eod = await $.command.run({ command: 'eod', args: '' } as never)
  expect(eod.text).toContain('src/login.ts')
  expect(eod.text).toContain('add login form')
})
