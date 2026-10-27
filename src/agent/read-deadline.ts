import { ExecutionDeadlineError } from '../engine/execution-error.js';
/** A read deadline is distinct from rejected target evidence or browser policy. */
export class ReadDeadlineError extends ExecutionDeadlineError {
  constructor(label: string) { super(`${label} timed out.`); this.name = 'ReadDeadlineError'; }
}

/** The caller owns one absolute deadline and checks it between browser reads. */
export async function boundedRead<T>(read: () => Promise<T>, options: {
  deadline: number; signal?: AbortSignal; label: string; check: () => void;
}): Promise<T> {
  options.check();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { options.check(); return read(); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReadDeadlineError(options.label)), Math.max(1, options.deadline - Date.now()));
        onAbort = () => reject(options.signal?.reason ?? new Error(`${options.label} cancelled.`));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
      }),
    ]);
    options.check();
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}
