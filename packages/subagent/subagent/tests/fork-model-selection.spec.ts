import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Subagents from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations, startTestActivation } from './local-activation.ts'
import { TestSessionQuery } from './test-session-query.ts'

const input = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(Subagents)
  await ctx.plugin(Fork)
  await ctx.plugin(Spawn)
  const adapter = new MockAdapter(script, {
    efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
    defaultEffort: ReasoningEffortId('low'),
  })
  ctx.llm.registerAdapter(['mock', 'other'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), {
    provider: 'mock', model: 'model-a', reasoningEffort: ReasoningEffortId('high'),
  })
  return { ctx, adapter, parent }
}

describe('fork child model selection', () => {
  it.each(['fork', 'spawn'])('uses an explicit %s child route instead of the inherited request header', async (provider) => {
    const { ctx, adapter, parent } = await setup([textResponse('parent done'), textResponse('child done')])
    parent.followup(input('parent task'))
    await parent.whenIdle()
    const run = await startTestActivation(ctx, provider, {
      parent, prompt: input('child task').content,
      agentOptions: { provider: 'other', model: 'model-b', reasoningEffort: ReasoningEffortId('low') },
    })
    await run.result
    const request = adapter.requests.find(request => request.sessionId === run.childId)
    expect(request).toMatchObject({ provider: 'other', model: 'model-b', reasoningEffort: 'low' })
    expect(parent.model.current()).toEqual({ provider: 'mock', model: 'model-a', reasoningEffort: 'high' })
    await run.dispose()
  })

  it('uses the parent route captured during a new-model turn outside the inherited prefix', async () => {
    const { ctx, adapter, parent } = await setup([textResponse('old answer'), 'hang', textResponse('child answer')])
    parent.followup(input('old task'))
    await parent.whenIdle()
    parent.model.select({ provider: 'mock', model: 'model-b' })
    const started = Promise.withResolvers<undefined>()
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent === parent && frame.type === 'start' && frame.turn === 2) started.resolve(undefined)
    })
    parent.followup(input('new task'))
    await started.promise
    const run = await startTestActivation(ctx, 'fork', { parent, prompt: input('child task').content })
    await run.result
    expect(adapter.requests.find(request => request.sessionId === run.childId)).toMatchObject({ model: 'model-b' })
    await run.dispose()
    parent.cancel({ kind: 'user' })
    await parent.whenIdle()
  })

  it('clears inherited explicit effort and preserves a later child selection on cold resume', async () => {
    const { ctx, adapter, parent } = await setup([textResponse('parent done'), textResponse('child done'), textResponse('continued')])
    parent.followup(input('parent task'))
    await parent.whenIdle()
    let firstChild = true
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent && firstChild) {
        firstChild = false
        agent.model.select({ provider: 'other', model: 'model-c' })
      }
    })
    const run = await startTestActivation(ctx, 'fork', {
      parent, prompt: input('child task').content,
      agentOptions: { provider: 'mock', model: 'model-a', reasoningEffort: undefined },
    })
    await run.result
    expect(adapter.requests.find(request => request.sessionId === run.childId))
      .toMatchObject({ provider: 'other', model: 'model-c', reasoningEffort: 'low' })
    await run.dispose()
    ctx.on('agent/pre-step', ({ agent }, next) => agent === parent ? Promise.resolve({ kind: 'reject' as const }) : next())
    await ctx.subagents.sendMessage(parent, run.childId, input('continue').content, { signal: new AbortController().signal })
    await ctx.subagents.waitForTreeWork(parent)
    expect(adapter.requests.at(-1)).toMatchObject({ provider: 'other', model: 'model-c', reasoningEffort: 'low' })
  })

  it('uses the adapter default after an explicit same-route effort clear', async () => {
    const { ctx, adapter, parent } = await setup([textResponse('parent done'), textResponse('child done')])
    parent.followup(input('parent task'))
    await parent.whenIdle()
    const run = await startTestActivation(ctx, 'fork', {
      parent, prompt: input('child task').content,
      agentOptions: { reasoningEffort: undefined },
    })
    await run.result
    expect(adapter.requests.find(request => request.sessionId === run.childId)).toMatchObject({ reasoningEffort: 'low' })
    await run.dispose()
  })
})
