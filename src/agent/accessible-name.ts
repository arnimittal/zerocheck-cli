import { bindDOMLocator } from './dom-reader.js';
import type { ElementHandle, Locator } from 'playwright';
import { parse as parseYaml } from 'yaml';

/** Locator resolution stays in the isolated world; the callback compares only
 * existing native handles and never queries or trusts properties on the page. */
export async function locatorIndexOfHandle(locator: Locator, selected: ElementHandle): Promise<number> {
  const candidates = await locator.elementHandles();
  try {
    return await selected.evaluate((element, candidates) => {
      for (let i = 0; i < candidates.length; i++) if (candidates[i] === element) return i;
      return -1;
    }, candidates);
  } finally { await Promise.all(candidates.map(candidate => candidate.dispose())); }
}

export async function locatorIncludesHandle(locator: Locator, selected: ElementHandle): Promise<boolean> {
  return await locatorIndexOfHandle(locator, selected) >= 0;
}

async function exactSnapshot(handle: ElementHandle<SVGElement | HTMLElement>): Promise<string> {
  const lease = await bindDOMLocator(handle);
  try {
    const snapshot = await lease.locator.ariaSnapshot({ timeout: 1000 });
    await lease.assertCurrent();
    return snapshot;
  } finally { await lease.release(); }
}

/** Use the same isolated accessible-name implementation as native role binding. */
export async function readAccessibleName(handle: ElementHandle<SVGElement | HTMLElement>, role?: string | null, proposedName?: string): Promise<string> {
  const frame = await handle.ownerFrame();
  if (!frame) throw new Error('Target detached before accessible-name inspection.');
  const snapshot = await exactSnapshot(handle);
  const labelledNativeInput = (role === 'checkbox' || role === 'radio') && await handle.getAttribute('type') === role;
  const labelledEditable = role === 'textbox' && ['', 'true', 'plaintext-only'].includes((await handle.getAttribute('contenteditable') ?? 'none').toLowerCase());
  if (!snapshot && (labelledNativeInput || labelledEditable)) {
    // Hidden native inputs and empty editable text may omit an AX root. Prove
    // their exact native role/label membership; absence is not an empty-name allow.
    const proposed = proposedName ?? '';
    const namesakes = labelledNativeInput ? frame.getByRole(role as 'checkbox' | 'radio', { name: proposed, exact: true, includeHidden: true })
      : frame.getByLabel(proposed, { exact: true }).and(frame.locator('[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i]'));
    if (await locatorIncludesHandle(namesakes, handle)) return proposed;
  }
  let native: RegExpMatchArray | null;
  try {
    const root: unknown = parseYaml(snapshot)?.[0];
    const label = typeof root === 'string' ? root : root && typeof root === 'object' ? Object.keys(root)[0] : '';
    native = label?.match(/^([a-z][\w-]*)(?:\s+("(?:[^"\\]|\\.)*"))?(?:\s+\[[^\]]*\])*$/i) ?? null;
  } catch { throw new Error('Target accessible-name snapshot is unavailable or malformed.'); }
  if (!native) throw new Error('Target accessible-name snapshot is unavailable or malformed.');
  const compatible = role === 'textbox' ? ['textbox', 'searchbox', 'spinbutton', 'generic', 'text'] : [role];
  if (role && !compatible.includes(native[1])) throw new Error('Target role changed during accessible-name inspection.');
  try { return native[2] ? JSON.parse(native[2]) as string : ''; }
  catch { throw new Error('Target accessible-name snapshot is unavailable or malformed.'); }
}

