/**
 * Bus integration test.
 *
 * Verifies that:
 * 1. A message published via emit() is received by a subscriber exactly once
 *    (single-delivery guarantee via NOTIFY round-trip, no double-emit).
 * 2. off() correctly removes the listener.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { HubBusEvent } from '@relayroom/shared'
import { createBus } from '../src/bus'
import { TEST_DATABASE_URL } from './helpers'

const bus = createBus({ connectionString: TEST_DATABASE_URL })

afterAll(() => bus.close())

describe('Postgres LISTEN/NOTIFY bus', () => {
  it('delivers a message exactly once to a subscriber', async () => {
    const received: string[] = []

    const listener = (event: HubBusEvent) => {
      if (event.kind === 'message') received.push(event.subject)
    }
    bus.on('message', listener)

    bus.emit('message', {
      kind: 'message',
      projectId: 'p-bus-1',
      project: 'bus-test',
      part: 'test-agent',
      threadId: 'tid-1',
      messageId: 'mid-1',
      subject: 'bus-hello',
      fromPart: 'tester',
    })

    // Wait up to 3 seconds for the NOTIFY round-trip.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('bus delivery timed out')), 3000)
      const poll = setInterval(() => {
        if (received.length > 0) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolve()
        }
      }, 10)
    })

    bus.off('message', listener)

    // Exactly one delivery — no double-emit.
    expect(received).toHaveLength(1)
    expect(received[0]).toBe('bus-hello')
  })

  it('does not deliver to a removed listener', async () => {
    const received: string[] = []
    const listener = (event: HubBusEvent) => {
      if (event.kind === 'message') received.push(event.subject)
    }

    bus.on('message', listener)
    bus.off('message', listener)

    bus.emit('message', {
      kind: 'message',
      projectId: 'p-bus-2',
      project: 'bus-test',
      part: 'test-agent',
      threadId: 'tid-2',
      messageId: 'mid-2',
      subject: 'should-not-arrive',
      fromPart: 'tester',
    })

    // Wait long enough for a NOTIFY round-trip to complete.
    await new Promise(r => setTimeout(r, 500))

    expect(received).toHaveLength(0)
  })
})
