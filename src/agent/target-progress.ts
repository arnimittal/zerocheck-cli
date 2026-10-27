import { readDOM, selectDOM, selectAllDOM, sameDOMNode } from './dom-reader.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Step } from '../parser/types.js';
import type { VisibleTextAssertion } from '../../shared/outcomes.js';
import type { ElementHandle } from 'playwright';
import { readTargetIdentity } from './target-identity.js';
import { boundedRead, ReadDeadlineError } from './read-deadline.js';
import { isTransientObservationError } from './observation-recovery.js';
import { ExecutionError } from '../engine/execution-error.js';
import type { facts } from './dom-operations.js';

type Handle = ElementHandle<SVGElement | HTMLElement>;
type ProgressView = ReturnType<typeof facts.progressView>;
type Prepared = { handle: Handle; scope?: Handle; signature: string; view: ProgressView; lineNumber: number; entity?: string };
/** One private repeat guard, not a cache hint or assertion result. */
export class TargetProgress {
  private previous?: Prepared & { sequence: number; before: Map<string, boolean>; confirmed: boolean };
  async wait(handle: Handle, deadline: number, signal?: AbortSignal): Promise<void> {
    const prior = this.previous;
    if (!prior || prior.confirmed) return;
    const check = () => { signal?.throwIfAborted(); if (Date.now() >= deadline) throw new ReadDeadlineError('Repeated control has not changed view or outcome; wait for a relevant outcome before activating it again'); };
    const read = <T>(work: () => Promise<T>) => boundedRead(work, { deadline, signal, label: 'Repeated control readiness', check });
    const frame = await read(() => handle.ownerFrame());
    if (!frame) throw new ExecutionError('infrastructure', 'Current target frame is unavailable for repeat validation.');
    try {
      if (frame !== await read(() => prior.handle.ownerFrame())
        || !await read(() => handle.evaluate((element, previous) => element === previous, prior.handle))) return;
    } catch (error) {
      // Only native handle/context operations belong here. A destroyed old
      // context cannot own this readable current handle. Signature/page reads
      // below are deliberately outside this recovery boundary.
      if (!isTransientObservationError(error)) throw error;
      await read(() => handle.evaluate(() => true));
      return;
    }
    for (;;) {
      if (await read(() => signature(handle)) !== prior.signature) return;
      if (prior.scope && await read(() => readDOM(prior.scope!, 'connected'))) {
        const current = await read(() => readDOM(prior.scope!, 'progressView'));
        if (prior.view.ready && current.ready) {
          const fieldsChanged = prior.view.fields.some(control => !current.fields.includes(control))
            && current.fields.some(control => !prior.view.fields.includes(control));
          // A fieldless wizard can change in place. Its own ready principal
          // heading permits the next authored action, never proves an outcome.
          const fieldlessTransition = (prior.view.fieldless || current.fieldless)
            && prior.view.heading && current.heading && prior.view.headingLevel === current.headingLevel
            && prior.view.heading !== current.heading;
          if (fieldsChanged || fieldlessTransition) return;
        }
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }
  async prepare(handle: Handle, lineNumber: number, entity?: string): Promise<Prepared> {
    const duplicate = (await handle.evaluateHandle(element => element)).asElement() as Handle;
    let scope: Handle | undefined;
    try {
    const scopeValue = await selectDOM(handle, 'progressScope');
    scope = scopeValue ?? undefined;
    return { handle: duplicate, ...(scope ? { scope } : {}), signature: await signature(handle), view: scope ? await readDOM(scope, 'progressView') : { fields: [], fieldless: false, ready: false }, lineNumber, entity }; }
    catch (error) { await duplicate.dispose(); await scope?.dispose(); throw error; }
  }
  reset(): void {
    void this.previous?.handle.dispose().catch(() => {});
    void this.previous?.scope?.dispose().catch(() => {});
    this.previous = undefined;
  }
  dispatched(prepared: Prepared, sequence: number, before: Map<string, boolean>): void {
    this.reset();
    this.previous = { ...prepared, sequence, before: new Map(before), confirmed: false };
  }
  async confirm(step: Step, predicate: VisibleTextAssertion, sequence: number, options: {
    deadline: number; signal?: AbortSignal; check: () => void;
  }): Promise<void> {
    options.check();
    const prior = this.previous;
    if (!prior?.scope || prior.sequence !== sequence || step.lineNumber !== prior.lineNumber + 1 || prior.before.get(step.raw) !== false) return;
    const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (prior.entity && !new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped(prior.entity)}(?![\\p{L}\\p{M}\\p{N}_])`, 'iu').test(step.argument)) return;
    const started = Date.now();
    if (options.deadline - started <= 250) return;
    const deadline = started + 250;
    const check = () => {
      options.check();
      if (Date.now() >= deadline) throw new ReadDeadlineError('Optional repeated-control outcome proof');
    };
    const read = async <T>(work: () => Promise<T>): Promise<T> => {
      check(); const result = await work(); check(); return result;
    };
    try {
      const confirmed = await boundedRead(async () => {
        const frame = await read(() => prior.handle.ownerFrame());
        if (!frame || await read(() => prior.scope!.ownerFrame()) !== frame) return false;
        const text = predicate.match === 'phrase' ? new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped(predicate.text)}(?![\\p{L}\\p{M}\\p{N}_])`, 'u') : predicate.text;
        const matches = await read(() => frame.getByText(text, { exact: predicate.match !== 'phrase' }).elementHandles());
        try {
          for (const match of matches) {
            if (await read(() => match.isVisible()) && await containsNative(prior.scope!, match as Handle, read)) return true;
          }
          return false;
        } finally { await Promise.all(matches.map(match => match.dispose())); }
      }, { deadline, signal: options.signal, label: 'Optional repeated-control outcome proof', check });
      // A late read may finish after its budget or a newer activation. It never
      // mutates guard state; only the bounded current result can confirm it.
      if (confirmed && this.previous === prior) prior.confirmed = true;
    } catch (error) {
      options.check();
      if (!(error instanceof ReadDeadlineError) && !isTransientObservationError(error)) throw error;
    }
  }

}

async function signature(handle: Handle): Promise<string> {
  const identity = await readTargetIdentity(handle, [], Number.MAX_SAFE_INTEGER);
  const state = await readDOM(handle, 'progressState');
  // Ordinary changing prose/countdowns are deliberately absent. Complete raw
  // facts remain controller-private; only a hash is retained for this run.
  return createHash('sha256').update(JSON.stringify([identity.role, identity.name, identity.href,
    identity.frame, state])).digest('hex');
}

async function containsNative(scope: Handle, match: Handle, read: <T>(work: () => Promise<T>) => Promise<T>): Promise<boolean> {
  if (!await read(() => readDOM(scope, 'connected'))) return false;
  const ancestors: Handle[] = [];
  try {
    await read(async () => { ancestors.push(...await selectAllDOM(match, 'ancestors')); });
    for (const ancestor of ancestors) {
      if (await read(() => sameDOMNode(ancestor, scope))) return true;
      if (await read(() => readDOM(ancestor, 'progressBoundary'))) return false;
    }
    return false;
  }
  finally { await Promise.all(ancestors.map(node => node.dispose())); }
}
