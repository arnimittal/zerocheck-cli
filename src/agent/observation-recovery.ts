import type { Page } from 'playwright';

/** Only errors from read-only browser observations belong in this classifier. */
export function isTransientObservationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/closed|cancel|abort|policy|ambiguous/i.test(message)) return false;
  return /Execution context was destroyed|Cannot find context with specified id|Frame was detached|frame has been detached|Stale computer-use observation: frame/i.test(message);
}

export interface ObservationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: unknown) => void;
}

/** Screenshot transport can fail while the original page remains usable. */
function isRecoverableScreenshotError(error: unknown): boolean {
  if (!(error instanceof Error) || /cancel|abort|policy|ambiguous/i.test(error.message)) return false;
  const firstLine = error.message.split(/\r?\n/, 1)[0];
  return firstLine === 'page.screenshot: Target page, context or browser has been closed'
    || firstLine === 'page.screenshot: Frame is currently attempting a navigation';
}

/** Positive, bounded evidence from the same page; a connection flag alone is insufficient. */
async function originalPageIsLive(page: Page, deadline: number, signal?: AbortSignal): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const context = page.context();
    const browser = context.browser();
    if (page.isClosed() || !browser?.isConnected() || !context.pages().includes(page) || signal?.aborted) return false;
    const timeout = Math.min(250, deadline - Date.now() - 50);
    if (timeout <= 0) return false;
    const live = await Promise.race([
      // This constant observation neither trusts page text nor performs an interaction.
      page.evaluate(() => 1).then(value => value === 1, () => false),
      new Promise<false>(resolve => {
        onAbort = () => resolve(false);
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => resolve(false), timeout);
        if (signal?.aborted) resolve(false);
      }),
    ]);
    return live && !signal?.aborted && !page.isClosed() && browser.isConnected() && context.pages().includes(page);
  } catch { return false; }
  finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** Re-observe the same page; this callback must never contain action dispatch. */
export async function retryObservation<T>(page: Page, read: (remainingMs: number) => Promise<T>, options: ObservationOptions = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  for (;;) {
    options.signal?.throwIfAborted();
    if (page.isClosed()) throw new Error('Browser page closed during observation.');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Browser observation timed out before a complete snapshot was available.');
    try {
      const value = await read(remaining);
      options.signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error('Browser observation timed out before a complete snapshot was available.');
      return value;
    } catch (error) {
      if (page.isClosed() || options.signal?.aborted || deadline - Date.now() <= 50) throw error;
      const transient = isTransientObservationError(error)
        || (isRecoverableScreenshotError(error) && await originalPageIsLive(page, deadline, options.signal));
      if (!transient || page.isClosed() || options.signal?.aborted || deadline - Date.now() <= 50) throw error;
      options.onRetry?.(error);
      await page.waitForTimeout(50);
    }
  }
}
