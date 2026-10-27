import { bindDOMLocator, type NativeLocatorLease } from './dom-reader.js';
import type { Page, Locator, ElementHandle } from 'playwright';
import { randomUUID } from 'node:crypto';
import { redactText, redactionValues } from '../security/redaction.js';
import sharp from 'sharp';
import type { PageState } from './types.js';
import { createTargetPolicy, type TargetPolicy } from '../policy/target-policy.js';
import { blockedFrameOrigins, frameDocumentState, isFrameVisible } from './frame-policy.js';
import { retryObservation, type ObservationOptions } from './observation-recovery.js';
import { boundedRead, ReadDeadlineError } from './read-deadline.js';
import { ExecutionError } from '../engine/execution-error.js';

// Structural DOM surface used inside Playwright's browser context. The server
// intentionally has no DOM lib; the CLI does, so avoid their differing globals.
interface FrameMaskOwner {
  isConnected: boolean;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
}

interface CDPAXNode {
  nodeId: string;
  role?: { value: unknown };
  name?: { value: unknown };
  value?: { value: unknown };
  properties?: Array<{ name: string; value?: { value: unknown } }>;
  childIds?: string[];
}

/**
 * Capture the current state of a page: screenshot + accessibility tree.
 * This is what the AI agent "sees" when deciding how to interact.
 */
export async function capturePageState(page: Page, logger?: (message: string) => void, secrets: readonly string[] = [], targetPolicy?: TargetPolicy, options: ObservationOptions = {}): Promise<PageState> {
  return retryObservation(page, remaining => capturePageStateOnce(page, logger, secrets, targetPolicy, remaining), options);
}

async function capturePageStateOnce(page: Page, logger: ((message: string) => void) | undefined, secrets: readonly string[], targetPolicy: TargetPolicy | undefined, timeoutMs: number): Promise<PageState> {
  targetPolicy?.assertCurrentUrl(page.url());
  const policy = observationPolicy(page, targetPolicy);
  const observations = await Promise.allSettled([
    captureScreenshotOnce(page, timeoutMs, secrets, policy),
    getAccessibilitySnapshot(page, logger, secrets),
    page.url(),
    page.title(),
  ]);
  // Finish every read (including mask cleanup) before another capture can start.
  for (const observation of observations) if (observation.status === 'rejected') throw observation.reason;
  const [screenshot, snapshot, url, title] = observations.map(observation => (observation as PromiseFulfilledResult<unknown>).value) as [Buffer, A11yNode | null, string, string];

  const frameTrees: string[] = [];
  const blocked = new Set<string>();
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      if (policy) {
        const denied = await blockedFrameOrigins(frame, policy);
        if (denied.length) { for (const origin of denied) blocked.add(origin); continue; }
      }
      // XML/tracker documents are masked as a whole; do not include their text.
      let htmlAncestry = true;
      for (let ancestor: import('playwright').Frame | null = frame; ancestor; ancestor = ancestor.parentFrame()) {
        if (!await isHtmlDocument(ancestor)) { htmlAncestry = false; break; }
      }
      if (!htmlAncestry) continue;
      if (!await isFrameVisible(frame)) continue;
      const path: string[] = []; let ancestor: import('playwright').Frame | null = frame;
      while (ancestor && ancestor !== page.mainFrame()) { path.unshift(ancestor.url()); ancestor = ancestor.parentFrame(); }
      frameTrees.push(redactText(`FRAME ${JSON.stringify(path)}\n${await frame.locator('body').ariaSnapshot({ timeout: 1000 })}`, secrets));
    } catch { /* A detached/loading frame will be observed again on recovery. */ }
  }
  const excluded = blocked.size ? `UNOBSERVED FRAME ORIGINS: ${[...blocked].join(', ')}. A configured allowed_origins restriction must include every frame ancestor; opaque or non-HTTP(S) origins cannot be granted. Background frames may be unrelated to the requested control.` : '';
  const accessibilityTree = redactText([serializeA11yTree(snapshot), ...frameTrees, excluded].filter(Boolean).join('\n'), secrets).slice(0, 60_000);
  const metadata = await sharp(screenshot).metadata();
  return { screenshot, accessibilityTree, url: redactText(url, secrets), title: redactText(title, secrets),
    observationId: randomUUID(), capturedAt: Date.now(), viewport: page.viewportSize() ?? undefined,
    imageSize: metadata.width && metadata.height ? { width: metadata.width, height: metadata.height } : undefined };

}

/**
 * Get accessibility tree via CDP (page.accessibility was deprecated in Playwright).
 */
async function getAccessibilitySnapshot(page: Page, logger?: (message: string) => void, secrets: readonly string[] = []): Promise<A11yNode | null> {
  let client: import('playwright').CDPSession | null = null;
  try {
    client = await page.context().newCDPSession(page);
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    // CDP splits long text into InlineTextBox fragments. Redacting their complete
    // ancestor must redact descendants too, before any fragment is serialized.
    const axNodes = nodes as CDPAXNode[];
    const byId = new Map(axNodes.map(node => [node.nodeId, node]));
    const hidden = new Set<string>();
    const protectedValues = redactionValues(secrets);
    const pending = axNodes.filter(node => protectedValues.some(secret => String(node.name?.value ?? '').includes(secret) || String(node.value?.value ?? '').includes(secret))).map(node => node.nodeId);
    while (pending.length) { const id = pending.pop()!; if (hidden.has(id)) continue; hidden.add(id); pending.push(...(byId.get(id)?.childIds ?? [])); }
    return buildTreeFromCDP(axNodes.map(node => ({ ...node,
      name: node.name ? { value: hidden.has(node.nodeId) ? '[redacted]' : redactText(String(node.name.value ?? ''), secrets) } : undefined,
      value: node.value ? { value: hidden.has(node.nodeId) ? '[redacted]' : redactText(String(node.value.value ?? ''), secrets) } : undefined,
    })));
  } catch (error) {
    logger?.(
      `[page-state] WARNING: Failed to capture accessibility tree via CDP. ` +
      `Agent will rely on screenshot only — element identification accuracy will be degraded. ` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  } finally {
    // Always detach to prevent CDP session leak
    await client?.detach().catch(() => {});
  }
}

function buildTreeFromCDP(nodes: CDPAXNode[]): A11yNode | null {
  if (!nodes || nodes.length === 0) return null;

  const nodeMap = new Map<string, A11yNode>();

  for (const node of nodes) {
    const a11yNode: A11yNode = {
      role: axText(node.role?.value) ?? 'none',
      name: axText(node.name?.value),
      value: axText(node.value?.value),
      children: [],
    };
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === 'focused' && prop.value?.value) a11yNode.focused = true;
        if (prop.name === 'checked') a11yNode.checked = prop.value?.value as boolean | 'mixed' | undefined;
        if (prop.name === 'disabled' && prop.value?.value) a11yNode.disabled = true;
        if (prop.name === 'expanded') a11yNode.expanded = prop.value?.value as boolean | undefined;
      }
    }
    nodeMap.set(node.nodeId, a11yNode);
  }

  // Build tree from parent-child relationships
  for (const node of nodes) {
    // Child documents are captured separately after checking their entire ancestry.
    if (node.childIds && !/^iframe$/i.test(String(node.role?.value))) {
      const parent = nodeMap.get(node.nodeId);
      if (parent) {
        for (const childId of node.childIds) {
          const child = nodeMap.get(childId);
          if (child) parent.children!.push(child);
        }
      }
    }
  }

  return nodeMap.get(nodes[0].nodeId) ?? null;
}

/**
 * Capture and resize a screenshot to max 1280x720 PNG.
 * Smaller images = fewer tokens when sent to Claude.
 *
 * Exported for deterministic step handlers which need a "before" screenshot
 * for evidence but don't need the (much more expensive) full a11y tree.
 */
export async function captureScreenshot(page: Page, timeoutMs = 5000, secrets: readonly string[] = [], targetPolicy?: TargetPolicy): Promise<Buffer> {
  return retryObservation(page, remaining => captureScreenshotOnce(page, remaining, secrets, targetPolicy), { timeoutMs });
}

// A timed-out capture keeps ownership until its pending browser read and mask
// cleanup settle. A later capture may wait, but never creates overlapping work.
// The check's existing browser watchdog owns termination of a stuck renderer.
const captures = new WeakMap<Page, Promise<Buffer>>();
async function captureScreenshotOnce(page: Page, timeoutMs: number, secrets: readonly string[], targetPolicy?: TargetPolicy): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    if (page.isClosed()) throw new Error('Browser page closed during screenshot capture.');
    if (Date.now() >= deadline) throw new ReadDeadlineError('Screenshot capture');
  };
  for (let prior = captures.get(page); prior; prior = captures.get(page)) {
    await boundedRead(() => prior.then(() => undefined, () => undefined), { deadline, label: 'Screenshot cleanup', check });
  }
  check();
  const work = captureScreenshotWork(page, deadline, secrets, targetPolicy);
  captures.set(page, work);
  void work.finally(() => { if (captures.get(page) === work) captures.delete(page); }).catch(() => {});
  return boundedRead(() => work, { deadline, label: 'Screenshot capture', check });
}

async function captureScreenshotWork(page: Page, deadline: number, secrets: readonly string[], targetPolicy?: TargetPolicy): Promise<Buffer> {
  const remaining = () => {
    if (page.isClosed()) throw new Error('Browser page closed during screenshot capture.');
    if (Date.now() >= deadline) throw new ReadDeadlineError('Screenshot capture');
    return Math.max(1, deadline - Date.now());
  };
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    remaining(); const value = await operation(); remaining(); return value;
  };
  const policy = observationPolicy(page, targetPolicy);
  const mask: Locator[] = [];
  const owners: ElementHandle<FrameMaskOwner>[] = [];
  const maskedOwnerFrames = new Map<ElementHandle<FrameMaskOwner>, import('playwright').Frame>();
  const ownerLeases: NativeLocatorLease[] = [];
  let frameChanged = false;
  const invalidate = () => { frameChanged = true; };
  page.on('frameattached', invalidate); page.on('framedetached', invalidate); page.on('framenavigated', invalidate);
  try {
    const frames = page.frames();
    const frameState = [];
    for (const frame of frames) {
      const document = await read(() => frameDocumentState(frame, remaining()));
      frameState.push({ frame, parent: frame.parentFrame(), url: frame.url(), origin: document.origin, html: document.contentType === 'text/html' });
    }
    const states = new Map(frameState.map(state => [state.frame, state]));
    const maskedFrames = new Set<import('playwright').Frame>();
    for (const frame of frames) {
      const ancestry: import('playwright').Frame[] = [];
      for (let ancestor: import('playwright').Frame | null = frame; ancestor; ancestor = ancestor.parentFrame()) ancestry.unshift(ancestor);
      const excluded = ancestry.find(ancestor => {
        const state = states.get(ancestor);
        if (!state) throw new Error('Stale computer-use observation: frame ancestry changed before screenshot masking.');
        return !state.html || policy && !policy.evaluate(state.origin).allowed;
      });
      if (excluded) {
        if (maskedFrames.has(excluded)) continue;
        maskedFrames.add(excluded);
        if (excluded === page.mainFrame()) {
          throw new Error('Browser observation unavailable: screenshot withheld because the main document is not permitted HTML.');
        }
        // A private isolated-world association follows this exact owner even if
        // siblings reorder during capture. It never mutates the application DOM.
        // Mask from the first permitted HTML ancestor: injecting Playwright's mask into
        // XML documents crashes, and masking inside a denied ancestor cannot protect it.
        const element = await excluded.frameElement() as unknown as ElementHandle<FrameMaskOwner>;
        owners.push(element);
        remaining();
        const owner = await read(() => element.ownerFrame());
        if (!owner || !states.get(owner)?.html || await read(() => element.contentFrame()) !== excluded) throw new Error('Stale computer-use observation: frame ownership changed before screenshot masking.');
        const lease = await read(async () => {
          const lease = await bindDOMLocator(element); ownerLeases.push(lease); return lease;
        });
        if (await read(() => element.contentFrame()) !== excluded) throw new Error('Browser observation unavailable: frame mask could not be established safely; screenshot withheld.');
        maskedOwnerFrames.set(element, excluded);
        mask.push(lease.locator);
        continue;
      }
      mask.push(frame.locator('input, textarea, [contenteditable=""], [contenteditable="true" i], [contenteditable="plaintext-only" i]'));
      for (const secret of redactionValues(secrets)) mask.push(frame.getByText(secret, { exact: false }));
    }
    const raw = await read(async () => {
      try { return await page.screenshot({ type: 'png', fullPage: false, timeout: remaining(), mask }); }
      catch (error) {
        // Native frame invalidation makes this whole mask set stale even when
        // Playwright fails before returning pixels. Rebuild it on a fresh read;
        // an attached, unchanged frame's unknown masking error stays terminal.
        if (frameChanged && !page.isClosed() && page.context().browser()?.isConnected()
          && Date.now() < deadline && !(error instanceof ExecutionError)
          && !(error instanceof Error && error.name === 'AbortError')) {
          throw new Error('Stale computer-use observation: frame context changed while screenshot failed; masked capture discarded.', { cause: error });
        }
        throw error;
      }
    });
    const currentFrames = page.frames();
    if (frameChanged || currentFrames.length !== frames.length || frames.some(frame => !currentFrames.includes(frame))) throw new Error('Stale computer-use observation: frame context changed during screenshot masking; image discarded.');
    for (const previous of frameState) {
      const current = await read(() => frameDocumentState(previous.frame, remaining()));
      if (previous.frame.parentFrame() !== previous.parent || previous.frame.url() !== previous.url || current.origin !== previous.origin || (current.contentType === 'text/html') !== previous.html) throw new Error('Stale computer-use observation: frame origin or ancestry changed during screenshot masking; image discarded.');
    }
    for (const lease of ownerLeases) await read(() => lease.assertCurrent());
    for (const owner of owners) if ( await read(() => owner.contentFrame()) !== maskedOwnerFrames.get(owner)) throw new Error('Stale computer-use observation: frame mask identity changed during capture; image discarded.');

    // Resize if larger than 1280x720
    const metadata = await read(() => sharp(raw).metadata());
    if (metadata.width && metadata.width > 1280) {
      return await read(() => sharp(raw)
        .resize(1280, 720, { fit: 'inside', withoutEnlargement: true })
        .png({ quality: 80 })
        .toBuffer());
    }

    remaining(); return raw;
  } finally {
    page.off('frameattached', invalidate); page.off('framedetached', invalidate); page.off('framenavigated', invalidate);
    await Promise.all(ownerLeases.map(lease => lease.release()));
    for (const owner of owners) {
      await owner.dispose().catch(() => {});
    }
  }
}

async function isHtmlDocument(frame: import('playwright').Frame): Promise<boolean> {
  return (await frameDocumentState(frame)).contentType === 'text/html';
}

function observationPolicy(page: Page, configured?: TargetPolicy): TargetPolicy | undefined {
  if (configured) return configured;
  // Standalone callers use the same unrestricted HTTP(S) observation default.
  try { return /^https?:/.test(page.url()) ? createTargetPolicy({ targetUrl: page.url() }) : undefined; } catch { return undefined; }
}

interface A11yNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  children?: A11yNode[];
  focused?: boolean;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  pressed?: boolean | 'mixed';
}

/**
 * Serialize accessibility tree as structured text.
 * Format: [role] "name" (value) {state}
 * Indented for hierarchy. Token-efficient for Claude.
 */
/**
 * Roles worth including in the serialized tree.
 * Skips noise nodes (generic, none, paragraph, etc.) to keep token count low.
 */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'tab', 'switch', 'slider', 'searchbox', 'spinbutton',
  'heading', 'img', 'navigation', 'banner', 'main', 'form', 'dialog',
]);

const MAX_TREE_LINES = 500;

function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > maxLen * 0.6 ? truncated.slice(0, lastSpace) : truncated;
}

export function serializeA11yTree(node: A11yNode | null, depth: number = 0): string {
  if (!node) return '(accessibility tree unavailable)';

  const lines: string[] = [];
  serializeNode(node, depth, lines);

  if (lines.length > MAX_TREE_LINES) {
    lines.length = MAX_TREE_LINES;
    lines.push(`  ... (truncated, ${MAX_TREE_LINES} of many nodes shown)`);
  }

  return lines.join('\n');
}

function axText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function serializeNode(node: A11yNode, depth: number, lines: string[]): void {
  if (lines.length >= MAX_TREE_LINES) return;

  const isInteractive = INTERACTIVE_ROLES.has(node.role);
  const name = axText(node.name);
  const value = axText(node.value);
  const hasName = !!name;

  // Skip noise nodes (generic, none, paragraph) unless they have a useful name
  if (!isInteractive && !hasName && depth > 1) {
    // Still recurse into children — interactive elements may be nested
    if (node.children) {
      for (const child of node.children) {
        serializeNode(child, depth, lines);
      }
    }
    return;
  }

  const indent = '  '.repeat(Math.min(depth, 6));
  const parts: string[] = [`[${node.role}]`];

  if (name) parts.push(`"${truncateAtWord(name, 120)}"`);
  if (value) parts.push(`(${truncateAtWord(value, 60)})`);

  const states: string[] = [];
  if (node.focused) states.push('focused');
  if (node.checked === true) states.push('checked');
  if (node.disabled) states.push('disabled');
  if (node.expanded !== undefined) states.push(node.expanded ? 'expanded' : 'collapsed');
  if (node.pressed === true) states.push('pressed');

  if (states.length > 0) parts.push(`{${states.join(', ')}}`);

  lines.push(`${indent}${parts.join(' ')}`);

  if (node.children) {
    for (const child of node.children) {
      serializeNode(child, depth + 1, lines);
    }
  }
}
