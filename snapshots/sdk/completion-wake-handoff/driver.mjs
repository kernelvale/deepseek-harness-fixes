/** Deliver a new task in the normal turn-to-idle microtask handoff. */
export const name = 'completion-wake-handoff-driver'
export const inject = ['agents']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario context. */
export function apply(ctx) {
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || event.data.turn !== 1 || session.header.origin === 'subagent') return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) throw new Error('handoff root is unavailable')
    queueMicrotask(() => agent.followup({
      id: 'handoff-followup', role: 'user', source: { kind: 'completion-wake-fixture' },
      content: [{ type: 'text', text: 'PARENT_QUEUED_TASK' }],
    }))
  })
}
