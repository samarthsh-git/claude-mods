import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'task-inbox',
  component: 'Pane',
  requestId: 'task-inbox',
  props: {
    title: 'Tasks',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('plan, to-dos and inbox dispatch', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const submitted: string[] = []
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.run', () => ({ text: 'engine' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => (submitted.push(e.text), { text: e.text }))
  on('tool.call', (_, e) => ({ result: { oldTodos: [], newTodos: [] } }) as never)

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'todo', args: 'write release notes' } as never)
  await $.command.run({ command: 'inbox', args: 'audit deps for CVEs' } as never)
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' }] } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Run tests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /audit deps/ })).toBeDefined()
  await ui.unmount()

  await $.command.run({ command: 'inbox', args: 'send' } as never)
  await clock.advance(200)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('audit deps for CVEs')
})
