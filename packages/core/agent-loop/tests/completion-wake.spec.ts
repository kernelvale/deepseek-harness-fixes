import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const input = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('completion-wake'), { provider: 'mock', model: 'mock' })
  const atFirstEnd = (operation: () => void) => {
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end' && event.data.turn === 1) queueMicrotask(operation)
    })
  }
  return { ctx, adapter, agent, atFirstEnd }
}

describe('normal-completion wake handoff', () => {
  it('keeps an empty turn whose ending append fails on the existing error handoff path', async () => {
    const { ctx, adapter, agent } = await setup([textResponse('unused')])
    let initial = true
    ctx.on('agent/pre-step', ({ messages }, next) => {
      if (!initial) return next()
      initial = false
      expect(messages).toHaveLength(1)
      vi.spyOn(agent.session, 'append').mockImplementationOnce(() => { throw new Error('ending unavailable') })
      return Promise.resolve({ kind: 'enter' as const, messages: [] })
    })
    ctx.on('agent/error', () => { queueMicrotask(() => { agent.followup(input('park after error')) }) })
    agent.followup(input('removed task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })

  it.each(['followup', 'steer'] as const)('delivers %s accepted after the last inbox check before idle', async (method) => {
    const { adapter, agent, atFirstEnd } = await setup([textResponse('first'), textResponse('second')])
    atFirstEnd(() => { agent[method](input('second task')) })
    agent.followup(input('first task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(agent.inbox.nextTurn.length + agent.inbox.nextStep.length).toBe(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
  })

  it('coalesces two handoff wakeups without overlapping drivers', async () => {
    const { adapter, agent, atFirstEnd } = await setup([textResponse('first'), textResponse('second'), textResponse('third')])
    atFirstEnd(() => {
      agent.followup(input('second task'))
      agent.followup(input('third task'))
    })
    agent.followup(input('first task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(agent.inbox.nextTurn.length + agent.inbox.nextStep.length).toBe(0)
    let open = false
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'turn/start') { expect(open).toBe(false); open = true }
      if (event.type === 'turn/end') { expect(open).toBe(true); open = false }
    }
    expect(open).toBe(false)
  })

  it('does not wake a message removed before handoff', async () => {
    const { adapter, agent, atFirstEnd } = await setup([textResponse('first')])
    atFirstEnd(() => {
      const removed = input('removed task')
      agent.followup(removed)
      agent.inbox.remove(removed.id)
    })
    agent.followup(input('first task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn.length + agent.inbox.nextStep.length).toBe(0)
  })

  it('keeps handoff context parked until a later waking message arrives', async () => {
    const { adapter, agent, atFirstEnd } = await setup([textResponse('first'), textResponse('second')])
    atFirstEnd(() => { agent.inject(input('parked context')) })
    agent.followup(input('first task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextStep).toHaveLength(1)
    agent.followup(input('later task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('parked context')
  })

  it('parks a handoff wake that the user subsequently cancels while preserving its input', async () => {
    const { adapter, agent, atFirstEnd } = await setup([textResponse('first'), textResponse('second'), textResponse('third')])
    atFirstEnd(() => {
      agent.followup(input('preserved task'))
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    })
    agent.followup(input('first task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    agent.followup(input('later wake'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
  })

  it('replays a new wake after cancellation in the same handoff', async () => {
    const { adapter, agent, atFirstEnd } = await setup([textResponse('first'), textResponse('second'), textResponse('third')])
    atFirstEnd(() => {
      agent.followup(input('preserved task'))
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      agent.followup(input('new wake after cancel'))
    })
    agent.followup(input('first task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(agent.inbox.nextTurn.length + agent.inbox.nextStep.length).toBe(0)
  })

  it.each(['user', 'disposed'] as const)('does not restart after a %s cancellation clears the handoff work', async (kind) => {
    const { adapter, agent, atFirstEnd } = await setup([textResponse('first')])
    atFirstEnd(() => {
      agent.followup(input('cancelled task'))
      agent.cancel({ kind })
    })
    agent.followup(input('first task'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn.length + agent.inbox.nextStep.length).toBe(0)
  })
})
