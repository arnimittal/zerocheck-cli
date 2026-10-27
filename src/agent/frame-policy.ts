import { initializePointerInspection } from './pointer-native.js';
import { initializeDOMInspection } from './dom-reader.js';
import { selectors, type Frame } from 'playwright';
import type { TargetPolicy } from '../policy/target-policy.js';

const INSPECTION_SELECTOR = 'zerocheck_document_facts_v1';
const registrationKey = Symbol.for('zerocheck.document-facts-selector.v1');
const registry = selectors as typeof selectors & { [registrationKey]?: Promise<void> };
// A selector registry can be shared by multiple loaded engine modules. Register
// this fixed implementation once, before its first use, never from page input.
const registration = registry[registrationKey] ??= selectors.register(INSPECTION_SELECTOR, { content: `({
  queryAll(root) {
    const document = root.ownerDocument || root;
    const metadata = document.createElement('meta');
    metadata.setAttribute('content', JSON.stringify({ origin: document.defaultView.origin, contentType: document.contentType }));
    return [metadata];
  }
})` }, { contentScript: true });

/** Must settle before a runner creates contexts and their isolated worlds. */
export async function initializeFrameInspection(): Promise<void> { await Promise.all([registration, initializeDOMInspection(), initializePointerInspection()]); }

/** Exact-frame native facts read in Playwright's isolated utility world. */
export async function frameDocumentState(frame: Frame, timeoutMs = 1000): Promise<{ origin: string; contentType: string }> {
  await initializeFrameInspection();
  // getAttribute stays in the isolated world. Do not replace it with evaluate,
  // compose this selector with a page/model selector, or attach the metadata node.
  const encoded = await frame.locator(`${INSPECTION_SELECTOR}=read`).getAttribute('content', { timeout: timeoutMs });
  const state: unknown = encoded === null ? null : JSON.parse(encoded);
  if (!state || typeof state !== 'object' || !('origin' in state) || typeof state.origin !== 'string'
    || !('contentType' in state) || typeof state.contentType !== 'string') throw new Error('Browser document security facts are unavailable.');
  return { origin: state.origin, contentType: state.contentType };
}

/** Native opaque/inherited origins cannot be forged by a page's window.origin. */
export async function frameOrigin(frame: Frame): Promise<string> { return (await frameDocumentState(frame)).origin; }

/** Every embedding document has authority over its child, so every ancestor must be granted. */
export async function blockedFrameOrigins(frame: Frame, policy: TargetPolicy): Promise<string[]> {
  const blocked = new Set<string>();
  for (let ancestor: Frame | null = frame; ancestor; ancestor = ancestor.parentFrame()) {
    const origin = await frameOrigin(ancestor);
    if (!policy.evaluate(origin).allowed) blocked.add(origin);
  }
  return [...blocked];
}

export async function assertFrameAllowed(frame: Frame, policy: TargetPolicy): Promise<void> {
  for (let ancestor: Frame | null = frame; ancestor; ancestor = ancestor.parentFrame()) policy.assertCurrentUrl(await frameOrigin(ancestor));
}

export async function isAppFrame(frame: Frame, policy: TargetPolicy): Promise<boolean> {
  try {
    for (let ancestor: Frame | null = frame; ancestor; ancestor = ancestor.parentFrame()) if (await frameOrigin(ancestor) !== policy.appOrigin) return false;
    return true;
  } catch { return false; }
}

/** An absent current frame is distinct from a completed hidden-frame read.
 * Target enumeration may discard it; a text observation must retain the gap. */
export class NativeFrameDetachedError extends Error {
  constructor() { super('Frame was detached during visibility observation.'); this.name = 'NativeFrameDetachedError'; }
}

export async function isFrameVisible(frame: Frame): Promise<boolean> {
  // Capture before awaiting: detachment can clear parentFrame(), which must not
  // turn a retired embedded frame into an apparently visible top-level frame.
  const chain: Frame[] = [];
  for (let current: Frame | null = frame; current; current = current.parentFrame()) chain.push(current);
  const check = () => {
    if (frame.page().isClosed()) throw new Error('Browser page closed during frame visibility observation.');
    if (chain.some(current => current.isDetached())) throw new NativeFrameDetachedError();
  };
  check();
  for (const current of chain.slice(0, -1)) {
    let owner: Awaited<ReturnType<Frame['frameElement']>> | undefined;
    try {
      check(); owner = await current.frameElement(); check();
      const visible = await owner.isVisible(); check();
      if (!visible) return false;
    } catch (error) { check(); throw error; }
    finally { await owner?.dispose().catch(() => {}); }
  }
  check(); return true;
}
