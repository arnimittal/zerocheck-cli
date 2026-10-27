import type { FailureKind } from '../../shared/contracts.js';

/** Controller-owned classification. Page/model prose never selects a failure kind. */
export class ExecutionError extends Error {
  constructor(readonly failureKind: FailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExecutionError';
  }
}

export class ExecutionDeadlineError extends ExecutionError {
  constructor(message: string, options?: ErrorOptions) {
    super('infrastructure', message, options);
    this.name = 'TimeoutError';
  }
}

/** Inspect only the owning signal, never a Playwright action error's name. */
export function abortFailureKind(signal?: AbortSignal): 'cancelled' | 'infrastructure' | undefined {
  if (!signal?.aborted) return undefined;
  return signal.reason instanceof ExecutionDeadlineError
    || signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    ? 'infrastructure' : 'cancelled';
}
