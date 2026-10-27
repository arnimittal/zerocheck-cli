import { isTransientObservationError } from './observation-recovery.js';

/**
 * Pure helpers backing `Wait for <element>` step execution.
 *
 * The BrowserAgent's handleWait wires a live Playwright page + AI
 * provider into these helpers; splitting them out keeps the polling
 * logic unit-testable without needing a real browser.
 */

interface PresenceCheck {
  present: boolean;
  confidence: number;
  reasoning?: string;
}

interface PollOptions {
  description: string;
  deadlineMs: number;
  /** Absolute owner deadline; the authored duration may only shorten it. */
  deadline?: number;
  signal?: AbortSignal;
  pollIntervalMs: number;
  check: () => Promise<PresenceCheck>;
  sleep: (ms: number) => Promise<void>;
  /** Optional clock for deterministic testing. */
  now?: () => number;
}

interface PollOutcome {
  found: boolean;
  attempts: number;
  confidence: number;
  reasoning?: string;
}

/**
 * Parse a natural-language wait description. Supports an optional
 * `(up to N seconds)` suffix that overrides the default 30-second
 * deadline. Returns the cleaned description (without the suffix) so
 * the AI prompt and the error message don't include the author's
 * timeout syntax.
 */
export { parseWaitDescription } from '../../shared/outcomes.js';

/**
 * Poll a presence-check function until it returns `present: true`
 * with ≥70 confidence, or the overall deadline expires.
 *
 * Only recognized navigation/frame-transition observation errors can retry.
 * The caller bounds each read and sleep to the remaining budget; results
 * arriving at or after the deadline cannot establish presence.
 */
export async function pollForPresence(opts: PollOptions): Promise<PollOutcome> {
  const now = opts.now ?? Date.now;
  const deadline = Math.min(now() + opts.deadlineMs, opts.deadline ?? Infinity);
  let attempts = 0;
  let lastConfidence = 0;
  let lastReasoning: string | undefined;

  opts.signal?.throwIfAborted();
  while (now() < deadline) {
    opts.signal?.throwIfAborted();
    attempts++;
    try {
      const result = await opts.check();
      opts.signal?.throwIfAborted();
      if (now() >= deadline) {
        // A late observation is unknown, not authority to reuse an older negative.
        lastConfidence = 0;
        lastReasoning = undefined;
        break;
      }
      lastReasoning = result.reasoning;
      lastConfidence = result.confidence;

      if (result.present && result.confidence >= 70) {
        return {
          found: true,
          attempts,
          confidence: result.confidence,
          reasoning: result.reasoning,
        };
      }
    } catch (err) {
      opts.signal?.throwIfAborted();
      if (!isTransientObservationError(err)) throw err;
      lastConfidence = 0;
      lastReasoning = err instanceof Error ? err.message : String(err);
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await opts.sleep(Math.min(opts.pollIntervalMs, remaining));
    opts.signal?.throwIfAborted();
  }

  return {
    found: false,
    attempts,
    confidence: lastConfidence,
    reasoning: lastReasoning,
  };
}
