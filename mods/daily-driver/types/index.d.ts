export type Focus = { goal: string; setAt: number }

export type DayLog = {
  day: string
  prompts: number
  turns: number
  activeMs: number
  files: string[]
  commits: string[]
  testsPassed: number
  testsFailed: number
  agents: number
  goalsDone: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'daily-driver': { focus: Focus | null; today: DayLog | null; isBandHidden: boolean }
  }
}
