/**
 * AsyncPushQueue — push-based async iterable for multi-turn streaming input
 */

type QueueResult<T> =
  | { value: T; done: false }
  | { value: undefined; done: true };

export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private _buffer: T[] = [];
  private _resolve: ((result: QueueResult<T>) => void) | null = null;
  private _done = false;

  push(value: T): void {
    if (this._done) return;
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve({ value, done: false });
    } else {
      this._buffer.push(value);
    }
  }

  end(): void {
    this._done = true;
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  next(): Promise<QueueResult<T>> {
    if (this._buffer.length > 0) {
      return Promise.resolve({ value: this._buffer.shift()!, done: false });
    }
    if (this._done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  }
}
