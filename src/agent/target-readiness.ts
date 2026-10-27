import { readDOM } from './dom-reader.js';
import { TargetChangedError } from './target-errors.js';
import type { ElementHandle } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedRead, ReadDeadlineError } from './read-deadline.js';

/** Current applicability, separate from authored name/entity proof. */
export async function targetReadiness(handle: ElementHandle<SVGElement | HTMLElement>, ownSelectAX = false): Promise<{ active: boolean; moving: boolean }> {
  const state = await readDOM(handle, 'readiness', { ownSelectAX });
  if ('detached' in state && state.detached) throw new TargetChangedError('Target detached while waiting for its view.');
  return state;
}

/** Observe the same handle; never replace it with a currently enabled namesake. */
export async function waitForTargetReady(handle: ElementHandle<SVGElement | HTMLElement>, deadline: number, signal?: AbortSignal, ownSelectAX = false): Promise<void> {
  return waitForReadiness(handle, deadline, signal, ownSelectAX, false);
}

/** A preflight can start a hover transition. Wait on that same active control,
 * but never wait through an outgoing/hidden view or infer any target authority. */
export async function waitForActiveTargetStable(handle: ElementHandle<SVGElement | HTMLElement>, deadline: number, signal?: AbortSignal, ownSelectAX = false): Promise<void> {
  return waitForReadiness(handle, deadline, signal, ownSelectAX, true);
}

async function waitForReadiness(handle: ElementHandle<SVGElement | HTMLElement>, deadline: number, signal: AbortSignal | undefined, ownSelectAX: boolean, requireActive: boolean): Promise<void> {
  for (;;) {
    const state = await boundedRead(() => targetReadiness(handle, ownSelectAX), { deadline, signal, label: 'Target view readiness', check: () => { signal?.throwIfAborted(); if (Date.now() >= deadline) throw new ReadDeadlineError('Target view readiness'); } });
    if (requireActive && !state.active) throw new TargetChangedError('The target view changed before dispatch; observe the current view again.');
    if (state.active && !state.moving) return;
    signal?.throwIfAborted();
    await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}
