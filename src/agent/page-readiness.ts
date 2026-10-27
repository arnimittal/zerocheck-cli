import { readDOM } from './dom-reader.js';
import { type Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedRead, ReadDeadlineError } from './read-deadline.js';
import { isTransientObservationError } from './observation-recovery.js';

/** Readiness is an observation, never a model action or a global network-idle wait. */
export async function waitForUsablePage(page: Page, deadline: number, signal?: AbortSignal, settleMs = 0, allowLoading = false): Promise<void> {
  let previous = '';
  let stableSince = Date.now();
  let readySince: number | undefined;
  const check = () => {
    signal?.throwIfAborted();
    if (page.isClosed()) throw new Error('Browser page closed during readiness observation.');
    if (Date.now() >= deadline) throw new ReadDeadlineError('Browser readiness observation');
  };
  for (;;) {
    check();
    try {
      const read = <T>(work: () => Promise<T>) => boundedRead(work, { deadline, signal, label: 'Browser readiness observation', check });
      // Built-in locators use Playwright's isolated DOM helpers. Page analytics
      // can wrap main-world querySelectorAll; readiness must not depend on that hook.
      const body = page.locator('body');
      const text = (await read(() => body.innerText({ timeout: Math.max(1, deadline - Date.now()) }))).trim().replace(/\s+/g, ' ').slice(0, 20_000);
      const controls = await read(() => page.locator('button:enabled:visible:not([aria-disabled="true"]),input:enabled:visible:not([aria-disabled="true"]),select:enabled:visible:not([aria-disabled="true"]),textarea:enabled:visible:not([aria-disabled="true"]),a[href]:visible:not([aria-disabled="true"]),[role="button"]:visible:not([aria-disabled="true"]),[role="link"]:visible:not([aria-disabled="true"])').count()) > 0;
      let contentFrame = false;
      if (!text && !controls) {
        for (const frame of await read(() => page.locator('iframe:visible').all())) {
          const box = await read(() => frame.boundingBox({ timeout: Math.max(1, deadline - Date.now()) }));
          if (box && box.width >= 100 && box.height >= 100) { contentFrame = true; break; }
        }
      }
      const busy = await read(() => page.locator('body[aria-busy="true"]:visible,main[aria-busy="true"]:visible,[role="main"][aria-busy="true"]:visible').count()) > 0;
      const state = { ready: controls || (allowLoading || !busy) && (Boolean(text) || contentFrame) && (allowLoading || !/^(?:loading|please wait)(?:[.\s…!])*$/i.test(text)), key: text };
      if (state.ready) {
        readySince ??= Date.now();
        if (state.key !== previous) { previous = state.key; stableSince = Date.now(); }
        // Live counters must not prevent an otherwise usable page from being judged.
        if (!settleMs || Date.now() - stableSince >= settleMs || Date.now() - readySince >= 500) return;
      } else { readySince = undefined; stableSince = Date.now(); previous = state.key; }
    } catch (error) {
      if (!isTransientObservationError(error)) throw error;
      readySince = undefined; stableSince = Date.now();
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

/** A loader's text animation is not a new targeting opportunity. Observe control
 * structure/readiness instead, then spend the one fresh grounding call. */
export async function waitForGroundingOpportunity(page: Page, deadline: number, signal?: AbortSignal): Promise<void> {
  const read = () => boundedRead(async () => {
    const frames: string[] = [];
    for (const frame of page.frames()) {
      const controls = await readDOM(frame, 'controlReadiness');
      if (controls !== '[]') frames.push(controls);
    }
    return JSON.stringify(frames);
  }, {deadline,signal,label:'Grounding readiness',check:()=>{signal?.throwIfAborted();if(page.isClosed())throw new Error('Browser closed during grounding readiness.');}});
  let previous: string | undefined;
  while (Date.now() < deadline) {
    try { const current=await read();if(previous!==undefined&&current!==previous)return;previous=current; }
    catch(error) { if(error instanceof ReadDeadlineError)return;if(!isTransientObservationError(error))throw error; }
    await delay(Math.min(100, Math.max(1,deadline-Date.now())),undefined,{signal});
  }
}
