import { readDOM, selectDOM } from './dom-reader.js';
import { ExecutionError } from '../engine/execution-error.js';
import { SelectorOvermatchError, TargetChangedError } from './target-errors.js';
import { outsideQuotedText } from '../../shared/quoted-text.js';
import { explicitRoleTarget } from './authored-target.js';
import { targetReadiness } from './target-readiness.js';
import type { ElementHandle, Page, Locator, Frame } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionPlan } from './types.js';
import { boundedRead, ReadDeadlineError } from './read-deadline.js';
import { isTransientObservationError } from './observation-recovery.js';
import { hasOwnPointerSurface } from './pointer-receiver.js';

type AriaRole = Parameters<Page['getByRole']>[0];

const ARIA_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote',
  'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox',
  'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory',
  'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell',
  'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem',
  'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option',
  'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region',
  'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator',
  'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch',
  'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar',
  'tooltip', 'tree', 'treegrid', 'treeitem',
]);

function isAriaRole(s: string): s is AriaRole {
  return ARIA_ROLES.has(s);
}

export interface ResolvedElement {
  handle: ElementHandle<SVGElement | HTMLElement>;
  selector: string;
}

interface ResolveElementOptions {
  waitForVisibleMs?: number;
  signal?: AbortSignal;
  /** Shared controller/read deadline; handle acquisition must not reset it. */
  deadline?: number;
}

type Read = <T>(work: () => Promise<T>) => Promise<T>;

interface ResolvedLocator {
  locator: Locator;
  selector: string;
}

/** Parse one structured selector without narrowing its locator collection. */
export async function locatorForStructuredSelector(
  page: Page | Frame,
  selector: string,
): Promise<Locator> {
  const resolved = await trySelector(page, selector, true);
  if (!resolved) throw new ExecutionError('configuration', `Unsupported element selector: "${selector}"`);
  return resolved.locator;
}

/**
 * Resolve an ActionPlan's selector into a Playwright Locator.
 * Priority: a11y role → text → label → placeholder → CSS fallback.
 */
export async function resolveElement(page: Page | Frame, plan: ActionPlan): Promise<Locator> {
  return (await resolveLocatorWithSelector(page, plan)).locator;
}

export async function resolveElementWithSelector(
  page: Page | Frame,
  plan: ActionPlan,
  options: ResolveElementOptions = {},
): Promise<ResolvedElement> {
  const deadline = options.deadline ?? Date.now() + Math.max(1000, options.waitForVisibleMs ?? 0);
  const budget = resolutionBudget(page, { ...options, deadline });
  const resolved = await resolveLocatorWithSelector(page, plan, { ...options, deadline });
  const handle = await budget.read(() => resolved.locator.elementHandle({ timeout: Math.max(1, deadline - Date.now()) }).then(async acquired => {
    if (options.signal?.aborted || Date.now() >= deadline) { await acquired?.dispose().catch(() => {}); budget.check(); }
    return acquired;
  }));
  if (!handle) throw new ElementNotFoundError(plan);
  if (plan.action === 'click') {
    const ownControl = await budget.read(() => selectDOM(handle, 'ownControl'));
    const control = ownControl;
    if (control && !await budget.read(() => control.evaluate((element, original) => element === original, handle))) { await handle.dispose(); return { handle: control, selector: resolved.selector }; }
    await ownControl?.dispose();
  }
  return { handle, selector: resolved.selector };
}

function resolutionBudget(page: Page | Frame, options: ResolveElementOptions) {
  const deadline = options.deadline ?? Date.now() + Math.max(1000, options.waitForVisibleMs ?? 0);
  const check = () => {
    options.signal?.throwIfAborted();
    if (('isClosed' in page ? page : page.page()).isClosed()) throw new Error('Browser page closed during target observation.');
    if (Date.now() >= deadline) throw new ReadDeadlineError('Element resolution');
  };
  const read: Read = work => boundedRead(work, { deadline, signal: options.signal, label: 'Element resolution', check });
  return { deadline, read, check };
}

async function resolveLocatorWithSelector(
  page: Page | Frame,
  plan: ActionPlan,
  options: ResolveElementOptions = {},
): Promise<ResolvedLocator> {
  const waitForVisibleMs = options.waitForVisibleMs ?? 0;
  const budget = resolutionBudget(page, options);
  const deadline = Math.min(budget.deadline, Date.now() + waitForVisibleMs);

  for (;;) {
    budget.check();
    try {
      const frame = await budget.read(() => resolveFrame(page, plan.framePath));
      const resolved = await resolveLocatorOnce(frame, plan, waitForVisibleMs > 0, budget.read);
      if (resolved) return resolved;
    } catch (error) {
      if (error instanceof SelectorOvermatchError) throw error;
      const unavailable = isTransientObservationError(error) || error instanceof TargetChangedError;
      if (!unavailable || waitForVisibleMs === 0 || options.signal?.aborted) throw error;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(50, remainingMs), undefined, { signal: options.signal });
    if (Date.now() >= deadline) break;
  }
  throw new ElementNotFoundError(plan);
}

async function resolveLocatorOnce(
  page: Page | Frame,
  plan: ActionPlan,
  requireVisible: boolean,
  read: Read,
): Promise<ResolvedLocator | null> {
  const selectors = [plan.selector, plan.fallback_selector].filter(
    (selector): selector is string => Boolean(selector),
  );

  for (const selector of selectors) {
    try {
      const candidate = await trySelector(page, selector, false, read);
      if (!candidate) continue;
      if (plan.action === 'press' && selector.startsWith('label=')) {
        const name = selector.slice(6);
        // Keyboard targets may be named activation controls, not only fields.
        // Binding still requires the intended exact control and global uniqueness.
        for (const role of ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option'] as const) candidate.locator = candidate.locator.or(page.getByRole(role, { name, exact: true }));
      }
      const resolved = await pickBestMatch(candidate.locator, candidate.selector, requireVisible, read, plan.action === 'click');
      if (resolved) return resolved;
    } catch (error) { if (!isSelectorSyntaxError(error)) throw error; }
  }

  return null;
}

/**
 * Parse a selector string and return a Playwright Locator.
 * Supports our a11y-based selector format:
 *   role=button[name='Add to cart']
 *   text=Add to cart
 *   label=Email address
 *   placeholder=Enter email
 *   (anything else) → page.locator(css)
 */
async function trySelector(
  page: Page | Frame | Locator,
  selector: string,
  exact = false,
  read: Read = work => work(),
): Promise<{ locator: Locator; selector: string } | null> {
  const ordinalMatch = selector.match(/^(.+?)\s*>>\s*nth=(\d+)$/);
  if (ordinalMatch) {
    const base = await trySelector(page, ordinalMatch[1].trim(), exact, read);
    if (!base) return null;
    const ordinal = Number.parseInt(ordinalMatch[2], 10);
    return {
      locator: base.locator.nth(ordinal),
      selector: `${base.selector} >> nth=${ordinal}`,
    };
  }

  const separator = outsideQuotedText(selector).indexOf(' >> ');
  if (separator >= 0) {
    const scope = await trySelector(page, selector.slice(0, separator).trim(), true, read);
    if (!scope) return null;
    const target = await trySelector(scope.locator, selector.slice(separator + 4).trim(), exact, read);
    return target ? { locator: target.locator, selector } : null;
  }

  // role=button[name='Label'] or textbox[name='Label']
  const roleMatch = explicitRoleTarget(selector) ?? (/^(textbox|combobox|checkbox|radio|menuitem|tab|switch)\[/.test(selector) ? explicitRoleTarget(`role=${selector}`) : undefined);
  if (roleMatch) {
    const { role, name } = roleMatch;

    // For textbox, also try matching by placeholder (Claude often returns placeholder as name)
    if (role === 'textbox' && !exact) {
      const byRole = page.getByRole('textbox', { name, exact: true });
      if (await read(() => byRole.count()) > 0) return { locator: byRole, selector };
      const byPlaceholder = page.getByPlaceholder(name, { exact: true });
      if (await read(() => byPlaceholder.count()) > 0) {
        return { locator: byPlaceholder, selector: `placeholder=${name}` };
      }
      return { locator: page.getByRole('textbox', { name, exact: true }), selector };
    }

    if (isAriaRole(role)) return { locator: page.getByRole(role, { name, exact: true }), selector };
    if (selector.startsWith('role=')) return null;
    // HTML tag[name=...] is CSS unless the tag is an actual supported ARIA role.
  }

  // role=button (no name)
  const roleOnlyMatch = selector.match(/^role=(\w+)$/);
  if (roleOnlyMatch) {
    const r = roleOnlyMatch[1];
    if (isAriaRole(r)) return { locator: page.getByRole(r), selector };
    return null;
  }

  // text=...
  if (selector.startsWith('text=')) {
    return { locator: page.getByText(selector.slice(5), { exact: true }), selector };
  }

  // label=...
  if (selector.startsWith('label=')) {
    return { locator: page.getByLabel(selector.slice(6), { exact: true }), selector };
  }

  // placeholder=...
  if (selector.startsWith('placeholder=')) {
    return { locator: page.getByPlaceholder(selector.slice(12), { exact: true }), selector };
  }

  if (selector.startsWith('testid=')) return { locator: page.getByTestId(selector.slice(7)), selector };

  // CSS/xpath fallback
  try {
    return { locator: page.locator(selector), selector };
  } catch {
    return null;
  }
}

/**
 * Resolve only a unique visible target. Ambiguity is a failure, never an arbitrary first match.
 */
async function pickBestMatch(
  locator: Locator,
  selector: string,
  requireVisible = false,
  read: Read = work => work(),
  allowOwnSurface = false,
): Promise<ResolvedLocator | null> {
  const count = await read(() => locator.count());
  if (count === 0) return null;
  if (count === 1) {
    if (requireVisible && !(await read(() => visibleControl(locator, allowOwnSurface)))) return null;
    return { locator, selector };
  }
  const visible: number[] = [];
  for (let i = 0; i < count; i++) {
    const nth = locator.nth(i);
    if (await read(() => visibleControl(nth, allowOwnSurface))) visible.push(i);
    if (visible.length > 1) throw new SelectorOvermatchError(selector);
  }
  return visible.length === 1 ? { locator: locator.nth(visible[0]), selector } : null;
}

async function visibleControl(locator: Locator, allowOwnSurface: boolean): Promise<boolean> {
  const candidate = await locator.elementHandle();
  if (!candidate) return false;
  try {
    if (!(await targetReadiness(candidate)).active) return false;
    if (await candidate.isVisible()) return true;
    const labelVisible = await readDOM(candidate, 'labelVisible');
    return labelVisible || allowOwnSurface && await hasOwnPointerSurface(candidate);
  } finally { await candidate.dispose(); }
}

function isSelectorSyntaxError(error: unknown): boolean {
  return error instanceof Error && /InvalidSelectorError|while parsing (?:css )?selector|not a valid selector|Unknown engine|Unexpected token.*selector|Malformed selector/i.test(error.message);
}

export class ElementNotFoundError extends TargetChangedError {
  constructor(plan: ActionPlan) {
    super(
      `Could not find element. ` +
      `Selector: "${plan.selector}"` +
      (plan.fallback_selector ? `, Fallback: "${plan.fallback_selector}"` : '') +
      `. Confidence was ${plan.confidence}%. ` +
      `Reasoning: ${plan.reasoning}`
    );
    this.name = 'ElementNotFoundError';
  }
}

/** Frame scope must resolve uniquely at every level; frame order is never an identity. */
export async function resolveFrame(page: Page | Frame, path?: readonly string[]): Promise<Page | Frame> {
  if (!path?.length) return page;
  let frame = 'mainFrame' in page ? page.mainFrame() : page;
  for (const url of path) {
    const matches = frame.childFrames().filter(child => child.url() === url);
    if (!matches.length) throw new TargetChangedError('Frame target is stale or missing. Observe the page again before dispatch.');
    if (matches.length !== 1) throw new ExecutionError('configuration', 'Ambiguous frame target: more than one frame has this exact URL.');
    frame = matches[0];
  }
  return frame;
}
