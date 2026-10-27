import { ExecutionError } from '../engine/execution-error.js';
import type { Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import type { TargetPolicy } from '../policy/target-policy.js';
import { blockedFrameOrigins, frameDocumentState, isFrameVisible } from './frame-policy.js';
import { isTransientObservationError } from './observation-recovery.js';
import { readDOM } from './dom-reader.js';
import { boundedRead, ReadDeadlineError } from './read-deadline.js';

import type { VisibleTextAssertion } from '../../shared/outcomes.js';
export { parseVisibleTextAssertion, type VisibleTextAssertion } from '../../shared/outcomes.js';

/** An unreadable visible frame cannot establish absence or hint evidence. */
export class IncompleteTextObservationError extends ExecutionError {
  constructor() { super('infrastructure', 'Browser observation is inconclusive: a visible frame could not be inspected for text absence.'); this.name = 'IncompleteTextObservationError'; }
}

export class AssertionDeadlineError extends ExecutionError {
  constructor(assertion: string, timeoutMs: number) {
    super('assertion', `Assertion failed after ${timeoutMs}ms: ${assertion}`);
    this.name = 'AssertionDeadlineError';
  }
}

/** Phrase mode preserves case and word/identifier boundaries. */
function phrasePattern(text: string): RegExp {
  const escaped = text.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`, 'u');
}

/** Retry the same read-only predicate while the page renders; never change its expected outcome. */
export async function waitForVisibleText(
  page: Page,
  assertion: VisibleTextAssertion,
  timeoutMs: number,
  signal?: AbortSignal,
  targetPolicy?: TargetPolicy,
  stepDeadline?: number,
  onWindow?: (windowMs: number) => void,
  mode: 'window' | 'until' = 'window',
): Promise<boolean> {
  const started = Date.now();
  const deadline = Math.min(stepDeadline ?? Infinity, started + Math.max(0, timeoutMs));
  // A zero polling budget means one bounded observation, used for hint evidence.
  const readDeadline = timeoutMs === 0 ? Math.min(stepDeadline ?? Infinity, started + 1000) : deadline;
  const negative = !assertion.visible && timeoutMs > 0;
  const disappearance = negative && mode === 'until' && assertion.absence !== 'throughout' && assertion.windowMs === undefined;
  // Leave an actual browser-read budget after a full observation window.
  const reserve = Math.min(1000, Math.max(1, (deadline - started) / 4));
  const windowMs = negative ? assertion.windowMs ?? (disappearance ? 500 : Math.max(1, deadline - started - reserve)) : 0;
  if (negative && !disappearance && started + windowMs >= deadline) throw new ExecutionError('configuration', 'Invalid configuration: the negative observation window needs time for a final read within the step timeout.');
  const windowEnd = started + windowMs;
  if (negative) onWindow?.(windowMs);
  const check = () => {
    signal?.throwIfAborted();
    if (page.isClosed()) throw new Error('Browser page closed during text observation.');
    if (Date.now() >= readDeadline) throw new ReadDeadlineError('Text observation');
    targetPolicy?.assertCurrentUrl(page.url());
  };
  const read = <T>(work: () => Promise<T>) => boundedRead(work, { deadline: readDeadline, signal, label: 'Text observation', check });
  let observed = false;
  let interrupted: unknown;
  let absentSince: number | undefined;
  let gapDuringWindow = false;
  for (;;) {
    if (timeoutMs > 0 && Date.now() >= deadline) {
      signal?.throwIfAborted();
      if (observed) return false;
      throw interrupted ?? new ReadDeadlineError('Text observation');
    }
    // Keep the normal polling resolution after a complete negative. Do not
    // predict future read latency, or reuse a negative after an unknown read.
    if (observed && !negative && deadline - Date.now() < 50) {
      await delay(Math.max(1, deadline - Date.now()), undefined, { signal });
      continue;
    }
    check();
    try {
      let found = false;
      let unknown = false;
      for (const frame of page.frames()) {
        try {
          if (!await read(() => isFrameVisible(frame))) continue;
          let hiddenOwner = false;
          for (let current = frame; current.parentFrame(); current = current.parentFrame()!) {
            const owner = await read(() => current.frameElement());
            try {
              await read(() => readDOM(owner, 'revealForObservation'));
              const state = await read(() => readDOM(owner, 'perceptibleBounds'));
              if (state === 'hidden') { hiddenOwner = true; break; }
              if (state !== 'visible') throw new IncompleteTextObservationError();
            } finally { await owner.dispose(); }
          }
          if (hiddenOwner) continue;
          const facts = await read(() => frameDocumentState(frame));
          if (!/^https?:/.test(facts.origin) || !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(facts.contentType) || targetPolicy && (await read(() => blockedFrameOrigins(frame, targetPolicy))).length) { unknown = true; continue; }
          const locator = assertion.match === 'phrase'
            ? frame.getByText(phrasePattern(assertion.text))
            : frame.getByText(assertion.text, { exact: true });
          const count = await read(() => locator.count());
          for (let index = 0; index < count; index++) {
            const handle = await read(() => locator.nth(index).elementHandle());
            if (!handle) throw new Error('Text target detached during observation.');
            try {
              await read(() => readDOM(handle, 'revealForObservation'));
              const text = await read(() => readDOM(handle, 'perceptibleText'));
              if (assertion.match === 'phrase' ? phrasePattern(assertion.text).test(text) : text === assertion.text.replace(/\s+/g, ' ').trim()) { found = true; break; }
            } catch (error) {
              if (page.isClosed() || signal?.aborted || error instanceof ReadDeadlineError || isTransientObservationError(error)) throw error;
              unknown = true;
            } finally { await handle.dispose(); }
          }
        } catch (error) {
          if (page.isClosed() || signal?.aborted || error instanceof ReadDeadlineError || /TargetPolicy/.test(String(error))) throw error;
          // An unreadable frame supplies no absence evidence. Other readable
          // frames may still independently prove positive presence.
          if (isTransientObservationError(error)) throw error;
          unknown = true;
        }
        if (found) break;
      }
      if (!found && unknown) throw new IncompleteTextObservationError();
      observed = true;
      if (!negative) {
        if (found === assertion.visible) return true;
      } else {
        if (found) {
          absentSince = undefined;
          if (assertion.absence === 'throughout') return false;
        } else absentSince ??= Date.now();
        if (disappearance && !found && absentSince !== undefined && Date.now() - absentSince >= windowMs) return true;
        if (!disappearance && Date.now() >= windowEnd) {
          if (assertion.absence === 'throughout' && gapDuringWindow) throw new ReadDeadlineError('Complete nonappearance observation');
          return !found && absentSince !== undefined && Date.now() - absentSince >= Math.min(1000, Math.max(0, windowMs - 50));
        }
      }
    } catch (error) {
      // A partial or interrupted read is unknown, particularly for negative assertions.
      // One-shot evidence probes propagate it instead of turning it into absence.
      observed = false; interrupted = error;
      absentSince = undefined; gapDuringWindow = true;
      if (!(error instanceof IncompleteTextObservationError) && !isTransientObservationError(error) || page.isClosed() || signal?.aborted || timeoutMs === 0 || Date.now() >= deadline) throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { if (observed) return false; throw interrupted ?? new ReadDeadlineError('Text observation'); }
    await delay(Math.min(50, remaining, negative && !disappearance ? Math.max(1, windowEnd - Date.now()) : Infinity), undefined, { signal });
  }
}
