// @vitest-environment jsdom
/**
 * Client apply() registration tests: the browser half registers the branch
 * chip on the published `conversation.input.left` composer control slot.
 * This guards against registering an invented/removed slot name that accepts
 * no entry in the running rc.6 shell.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { BranchChip } from '../src/client/chips/BranchChip.tsx'

describe('client apply()', () => {
  it('registers the branch chip on the official composer control slot', () => {
    const register = vi.fn(() => () => undefined)
    const slotInject = vi.fn((_name: string, callback: () => () => void) => callback())

    const scope = {
      slots: { inject: slotInject, register },
      conversation: {},
      sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    }
    const ctx = {
      effect: vi.fn((fn: () => void) => { fn(); return () => {} }),
      locale: { register: vi.fn() },
      inject: vi.fn((_services: unknown, callback: (s: typeof scope) => void) => { callback(scope) }),
    }

    apply(ctx as never)

    // The registration waits on the conversation/sessions seam, then on the
    // official slot declaration before registering the chip component.
    expect(ctx.inject).toHaveBeenCalledWith(['slots', 'conversation', 'sessions'], expect.any(Function))
    expect(slotInject).toHaveBeenCalledWith('conversation.input.left', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'conversation.input.left',
        id: 'git-graph',
        order: 100,
      }),
      BranchChip,
    )
    expect(register).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'conversation.input.dock' }),
      expect.anything(),
    )
  })
})

