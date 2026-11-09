import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
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
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, parent }
}

describe('fork delegation inbox ownership', () => {
  it('does not replay a parent task queued before the inherited turn ended', async () => {
    const { ctx, adapter, parent } = await setup([textResponse('first done'), 'hang', textResponse('child done')])
    const entered = Promise.withResolvers<undefined>()
    ctx.on('agent/pre-step', ({ agent, turn }, next) => {
      if (agent === parent && turn === 2) entered.resolve(undefined)
      return next()
    })
    ctx.on('session/event', (session, event) => {
      if (session === parent.session && event.type === 'step/start' && event.data.turn === 1) {
        queueMicrotask(() => { parent.followup(input('parent-only queued task')) })
      }
    })
    parent.followup(input('first parent task'))
    await entered.promise
    const run = await startTestActivation(ctx, 'fork', { parent, prompt: input('delegated task').content })
    await run.result
    const requests = adapter.requests.filter(request => request.sessionId === run.childId)
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain('delegated task')
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('parent-only queued task')
    expect(parent.session.deriveMessages().some(message => JSON.stringify(message).includes('parent-only queued task'))).toBe(true)
    await run.dispose()
    parent.cancel({ kind: 'user' })
    await parent.whenIdle()
  })

  it('discards both inherited pending lists while retaining new child context and the parent queues', async () => {
    const { ctx, adapter, parent } = await setup([textResponse('child done'), textResponse('continued')])
    const parentTurn = input('parent pending turn')
    const parentStep = input('parent pending context')
    parent.session.append('turn/start', { turn: 1 })
    parent.inbox.append('next-turn', parentTurn)
    parent.inbox.append('next-step', parentStep)
    parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    ctx.on('agent/pre-step', ({ agent }, next) => agent === parent ? Promise.resolve({ kind: 'reject' as const }) : next())
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) agent.inject(input('child-only context'))
    })
    const run = await startTestActivation(ctx, 'fork', { parent, prompt: input('delegated task').content })
    await run.result
    const requests = adapter.requests.filter(request => request.sessionId === run.childId)
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain('child-only context')
    expect(JSON.stringify(requests[0]?.messages)).toContain('delegated task')
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('parent pending')
    expect(parent.inbox.nextTurn).toEqual([parentTurn])
    expect(parent.inbox.nextStep).toEqual([parentStep])
    const child = run.localAgent
    const cleared = child.session.snapshotEvents(child.session.inheritedEventCount)
      .filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')
    expect(cleared).toHaveLength(2)
    await run.dispose()

    await ctx.subagents.sendMessage(parent, child.id, input('continue delegated work').content, { signal: new AbortController().signal })
    await ctx.subagents.waitForTreeWork(parent)
    expect(adapter.requests.filter(request => request.sessionId === child.id)).toHaveLength(2)
    expect(JSON.stringify(adapter.requests.filter(request => request.sessionId === child.id).at(-1)?.messages)).not.toContain('parent pending')
  })
})
