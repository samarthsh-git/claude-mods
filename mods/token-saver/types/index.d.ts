export type TokenTally = {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  subagentTokens: number
  routed: number
  dedupedReads: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-saver': { tally: TokenTally }
  }
}
