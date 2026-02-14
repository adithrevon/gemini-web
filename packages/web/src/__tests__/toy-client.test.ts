/**
 * Toy Client E2E Tests
 *
 * Simulates exactly what the iOS app does. If these pass,
 * iOS will work without surprises.
 *
 * Flow: Create session → SSE connect → Spawn instance → Events → Replay
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startTestServer, post } from './helpers.js';
import type { TestServer, SseEvent } from './helpers.js';

// --- SSE helpers tailored for toy client testing ---

/** Connect to SSE and collect events until `predicate` fires or timeout. */
async function sseUntil(
  baseUrl: string,
  sessionId: string,
  predicate: (events: SseEvent[]) => boolean,
  timeoutMs = 5000,
  since?: number,
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const events: SseEvent[] = [];
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const qs = since !== undefined ? `?since=${since}` : '';

  try {
    const res = await fetch(
      `${baseUrl}/api/session/${sessionId}/events${qs}`,
      { signal: controller.signal },
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            events.push(JSON.parse(line.slice(6)) as SseEvent);
          } catch { /* skip */ }
        }
      }
      if (predicate(events)) {
        controller.abort();
        break;
      }
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

describe('Toy Client (iOS Simulator)', () => {
  let t: TestServer;

  beforeAll(async () => {
    t = await startTestServer();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  // ── 1. Session lifecycle ──────────────────────────────────────

  describe('Session lifecycle', () => {
    it('POST /api/session creates a new session', async () => {
      const r = await post(t.baseUrl, '/api/session', {});
      expect(r.status).toBe(200);
      expect(r.json?.['sessionId']).toBeDefined();
      expect(typeof r.json?.['sessionId']).toBe('string');
    });

    it('POST /api/session with existing sessionId resumes', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const id = r1.json?.['sessionId'] as string;

      const r2 = await post(t.baseUrl, '/api/session', { sessionId: id });
      expect(r2.status).toBe(200);
      expect(r2.json?.['sessionId']).toBe(id);
    });
  });

  // ── 2. SSE connect → session_state ────────────────────────────

  describe('SSE connect delivers session_state', () => {
    it('receives session_state event immediately on connect', async () => {
      const r = await post(t.baseUrl, '/api/session', {});
      const sessionId = r.json?.['sessionId'] as string;

      const events = await sseUntil(
        t.baseUrl,
        sessionId,
        (evts) => evts.some((e) => e.type === 'session_state'),
        2000,
      );

      const state = events.find((e) => e.type === 'session_state');
      expect(state).toBeDefined();
      expect(state?.['sessionId']).toBe(sessionId);
      expect(Array.isArray(state?.['instances'])).toBe(true);
      expect((state?.['instances'] as unknown[]).length).toBe(0);
    });
  });

  // ── 3. Spawn instance → updated session_state ─────────────────

  describe('Spawn instance', () => {
    it('returns instanceId and resolvedPath', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });

      expect(r2.status).toBe(200);
      expect(r2.json?.['instanceId']).toBeDefined();
      expect(typeof r2.json?.['instanceId']).toBe('string');
      expect(r2.json?.['resolvedPath']).toBe('/private/tmp');
    });

    it('SSE receives initial events after spawn (models_available, streaming_state)', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      // Connect SSE FIRST, then spawn
      const eventsPromise = sseUntil(
        t.baseUrl,
        sessionId,
        (evts) => evts.some((e) => e.type === 'claude:streaming_state'),
        10000,
      );

      // Spawn instance
      const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });
      const instanceId = r2.json?.['instanceId'] as string;
      expect(instanceId).toBeDefined();

      const events = await eventsPromise;

      // Verify session_state was received
      const sessionState = events.find((e) => e.type === 'session_state');
      expect(sessionState).toBeDefined();
      expect(sessionState?.['sessionId']).toBe(sessionId);

      // Should have claude:* events with seq numbers
      const claudeEvents = events.filter(
        (e) => typeof e.type === 'string' && e.type.startsWith('claude:'),
      );

      // Each claude event should have instanceId and seq
      for (const evt of claudeEvents) {
        expect(evt['instanceId']).toBe(instanceId);
        expect(typeof evt['seq']).toBe('number');
        expect((evt['seq'] as number) > 0).toBe(true);
      }
    });
  });

  // ── 4. Event shape verification ───────────────────────────────

  describe('Event shapes match iOS contract', () => {
    let sessionId: string;
    let instanceId: string;
    let capturedEvents: SseEvent[];

    beforeAll(async () => {
      // Create session + instance and collect initial events
      const r1 = await post(t.baseUrl, '/api/session', {});
      sessionId = r1.json?.['sessionId'] as string;

      const eventsPromise = sseUntil(
        t.baseUrl,
        sessionId,
        (evts) => evts.some((e) => e.type === 'claude:models_available'),
        10000,
      );

      const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });
      instanceId = r2.json?.['instanceId'] as string;
      capturedEvents = await eventsPromise;
    });

    it('session_state has correct shape', () => {
      const evt = capturedEvents.find((e) => e.type === 'session_state');
      expect(evt).toBeDefined();
      // Required fields
      expect(typeof evt?.['sessionId']).toBe('string');
      expect(Array.isArray(evt?.['instances'])).toBe(true);
    });

    it('claude:models_available has correct shape', () => {
      const evt = capturedEvents.find(
        (e) => e.type === 'claude:models_available',
      );
      expect(evt).toBeDefined();
      expect(evt?.['instanceId']).toBe(instanceId);
      expect(typeof evt?.['seq']).toBe('number');
      expect(Array.isArray(evt?.['models'])).toBe(true);

      // Each model should have value, label
      const models = evt?.['models'] as Array<Record<string, unknown>>;
      if (models.length > 0) {
        const m = models[0]!;
        expect(typeof m['value']).toBe('string');
        expect(typeof m['label']).toBe('string');
      }
    });
  });

  // ── 5. Event buffering & replay ───────────────────────────────

  describe('Event buffering and replay', () => {
    it('events have incrementing seq numbers', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      // Connect SSE and wait for initial events from spawn
      const eventsPromise = sseUntil(
        t.baseUrl,
        sessionId,
        (evts) => evts.filter((e) => e.type?.startsWith('claude:')).length >= 2,
        10000,
      );

      await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });

      const events = await eventsPromise;
      const claudeEvents = events.filter((e) => e.type?.startsWith('claude:'));

      // Seq numbers should be incrementing
      for (let i = 1; i < claudeEvents.length; i++) {
        const prev = claudeEvents[i - 1]!['seq'] as number;
        const curr = claudeEvents[i]!['seq'] as number;
        expect(curr).toBeGreaterThan(prev);
      }
    });

    it('reconnect with ?since=0 replays all buffered events', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      // First connection: spawn instance and collect events
      const firstEvents = await sseUntil(
        t.baseUrl,
        sessionId,
        (evts) => evts.some((e) => e.type === 'claude:models_available'),
        10000,
      );

      // Spawn instance during first connection
      await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });

      // Wait a bit for events to arrive
      await new Promise((r) => setTimeout(r, 2000));

      // Second connection with since=0 (replay all)
      const replayedEvents = await sseUntil(
        t.baseUrl,
        sessionId,
        (evts) => evts.some((e) => e.type === 'session_state'),
        3000,
        0, // since=0 means "give me everything"
      );

      // Should get session_state (always sent on connect)
      const sessionState = replayedEvents.find(
        (e) => e.type === 'session_state',
      );
      expect(sessionState).toBeDefined();
    });

    it('reconnect with ?since=N only replays events after N', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      // Connect and spawn to generate events
      const firstPromise = sseUntil(
        t.baseUrl,
        sessionId,
        (evts) => evts.some((e) => e.type === 'claude:models_available'),
        10000,
      );

      await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });

      const firstEvents = await firstPromise;
      const claudeEvents = firstEvents.filter((e) =>
        e.type?.startsWith('claude:'),
      );

      if (claudeEvents.length === 0) {
        // No claude events to replay (shouldn't happen, but be safe)
        return;
      }

      // Get the first event's seq to use as "since"
      const firstSeq = claudeEvents[0]!['seq'] as number;

      // Reconnect with since=firstSeq (should skip the first event)
      const replayed = await sseUntil(
        t.baseUrl,
        sessionId,
        (evts) => evts.some((e) => e.type === 'session_state'),
        3000,
        firstSeq,
      );

      // Any replayed claude events should have seq > firstSeq
      const replayedClaude = replayed.filter((e) =>
        e.type?.startsWith('claude:'),
      );
      for (const evt of replayedClaude) {
        expect((evt['seq'] as number)).toBeGreaterThan(firstSeq);
      }
    });
  });

  // ── 6. Commands ───────────────────────────────────────────────

  describe('Commands', () => {
    it('submit message returns 200 OK', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });
      const instanceId = r2.json?.['instanceId'] as string;

      // Wait for instance to be ready
      await new Promise((r) => setTimeout(r, 1000));

      const r3 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'submit',
        instanceId,
        text: 'say hello',
      });

      expect(r3.status).toBe(200);
      expect(r3.json?.['ok']).toBe(true);
    });

    it('submit generates text_delta events on SSE', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      // Connect SSE first
      const eventsPromise = sseUntil(
        t.baseUrl,
        sessionId,
        (evts) => evts.some((e) => e.type === 'claude:text_delta'),
        15000,
      );

      // Spawn instance
      const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });
      const instanceId = r2.json?.['instanceId'] as string;

      // Wait for instance ready
      await new Promise((r) => setTimeout(r, 1000));

      // Submit message
      await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'submit',
        instanceId,
        text: 'respond with exactly: hello world',
      });

      const events = await eventsPromise;

      // Should have text_delta events
      const textDeltas = events.filter(
        (e) => e.type === 'claude:text_delta',
      );
      expect(textDeltas.length).toBeGreaterThan(0);

      // Each should have correct shape
      for (const td of textDeltas) {
        expect(td['instanceId']).toBe(instanceId);
        expect(typeof td['text']).toBe('string');
        expect(typeof td['seq']).toBe('number');
      }
    });

    it('terminateInstance removes instance from session', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });
      const instanceId = r2.json?.['instanceId'] as string;

      const r3 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'terminateInstance',
        instanceId,
      });
      expect(r3.status).toBe(200);
      expect(r3.json?.['ok']).toBe(true);
    });

    it('command to wrong session returns 403', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const session1 = r1.json?.['sessionId'] as string;

      const r2 = await post(t.baseUrl, '/api/session', {});
      const session2 = r2.json?.['sessionId'] as string;

      const r3 = await post(t.baseUrl, `/api/session/${session1}/command`, {
        type: 'spawnInstance',
        projectPath: '/tmp',
      });
      const instanceId = r3.json?.['instanceId'] as string;

      // Try to submit from session2
      const r4 = await post(t.baseUrl, `/api/session/${session2}/command`, {
        type: 'submit',
        instanceId,
        text: 'should fail',
      });
      expect(r4.status).toBe(403);
    });
  });

  // ── 7. Error handling ─────────────────────────────────────────

  describe('Error handling', () => {
    it('invalid command type returns 400', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'nonexistent',
      });
      expect(r2.status).toBe(400);
    });

    it('missing instanceId returns 400', async () => {
      const r1 = await post(t.baseUrl, '/api/session', {});
      const sessionId = r1.json?.['sessionId'] as string;

      const r2 = await post(t.baseUrl, `/api/session/${sessionId}/command`, {
        type: 'submit',
        text: 'no instanceId',
      });
      expect(r2.status).toBe(400);
    });

    it('unknown session returns 404 for SSE', async () => {
      const res = await fetch(
        `${t.baseUrl}/api/session/nonexistent-id/events`,
      );
      expect(res.status).toBe(404);
    });

    it('unknown session returns 404 for command', async () => {
      const r = await post(
        t.baseUrl,
        '/api/session/nonexistent-id/command',
        { type: 'submit', instanceId: 'fake', text: 'test' },
      );
      expect(r.status).toBe(404);
    });
  });
});
