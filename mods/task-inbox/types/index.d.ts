export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export type PlanItem = { id: string; text: string; status: PlanStatus }

export type Todo = { id: string; text: string; isDone: boolean; createdAt: number }

export type InboxItem = { id: string; text: string; status: 'queued' | 'sent'; sentAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    'task-inbox': { plan: PlanItem[]; todos: Todo[]; inbox: InboxItem[] }
  }
}
