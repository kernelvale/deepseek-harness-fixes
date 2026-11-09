/** Select a fork child model after a completed parent request. */
export const name = 'fork-captured-model-driver'
export const inject = ['agents', 'subagents', 'llm', 'sessions']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario context. */
export function apply(ctx) {
  let queued = false
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent.session.header.origin === 'subagent' || status !== 'idle' || queued) return
    queued = true
    agent.followup({
      id: 'queued-parent-task', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'PARENT_QUEUED_TASK' }],
    })
  })
  ctx.on('llm/stream', (options, next) => {
    const session = options.sessionId === undefined ? undefined : ctx.sessions.get(options.sessionId)
    if (session?.header.origin === 'subagent') {
      if (!options.messages.some(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text === 'CHILD_TASK'))) {
        throw new Error('fork requested a model before receiving its delegated task')
      }
      if (options.model !== 'deepseek-v4-pro') throw new Error('fork ignored the captured child model')
    }
    return next()
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    if (agent.session.header.origin !== 'subagent' && turn === 2 && step === 1) {
      const started = await ctx.subagents.startActivation({
        provider: 'fork', label: 'snapshot child', parent: agent, signal, delivery: 'caller',
        prompt: [{ type: 'text', text: 'CHILD_TASK' }],
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      })
      const result = await started.result
      await started.dispose()
      if (result.stopReason !== 'completed') throw new Error('fork did not complete its delegated task')
    }
    return next()
  })
}
