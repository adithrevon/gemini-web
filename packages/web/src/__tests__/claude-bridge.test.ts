import { describe, it, expect } from 'vitest';
import { AsyncPushQueue } from '../claude-bridge/async-queue.js';

describe('AsyncPushQueue', () => {
  it('should deliver pushed values in order', async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.end();

    const values: number[] = [];
    for await (const v of q) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it('should resolve waiting consumer when value is pushed', async () => {
    const q = new AsyncPushQueue<string>();

    // Start consuming in the background
    const consumer = (async () => {
      const values: string[] = [];
      for await (const v of q) {
        values.push(v);
      }
      return values;
    })();

    // Push after a delay
    q.push('a');
    q.push('b');
    q.end();

    const values = await consumer;
    expect(values).toEqual(['a', 'b']);
  });

  it('should not deliver after end()', async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.end();
    q.push(2); // should be ignored
    await expect(q.next()).resolves.toEqual({ value: 1, done: false });
    await expect(q.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('should handle empty queue ending immediately', async () => {
    const q = new AsyncPushQueue<number>();
    q.end();
    const result = await q.next();
    expect(result.done).toBe(true);
  });
});
