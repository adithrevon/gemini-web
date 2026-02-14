/**
 * Typed error classes for Claude bridge
 */

export abstract class ClaudeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ModelFetchError extends ClaudeError {
  constructor(public override readonly cause: Error) {
    super('Failed to fetch supported models', 'MODEL_FETCH_ERROR', true);
  }
}

export class SessionNotInitializedError extends ClaudeError {
  constructor() {
    super('Claude session not initialized', 'SESSION_NOT_INITIALIZED', false);
  }
}

export class QueryAbortedError extends ClaudeError {
  constructor() {
    super('Query was aborted', 'QUERY_ABORTED', true);
  }
}
