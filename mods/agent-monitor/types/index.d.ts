export type AgentRunStatus = 'running' | 'done' | 'failed' | 'stopped'

export type AgentRun = {
  id: string
  description: string
  type: string
  model: string
  status: AgentRunStatus
  startedAt: number
  endedAt: number | null
  tools: number
  doing: string | null
  tokens: number | null
  summary: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { runs: AgentRun[]; tick: number; showAll: boolean }
  }
}
