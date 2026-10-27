import type { Page } from 'playwright';
import { readDOM, selectDOM } from './dom-reader.js';
import { ExecutionError } from '../engine/execution-error.js';
import { TargetChangedError } from './target-errors.js';
import type { ActionPlan, PageState } from './types.js';
import type { ResolvedElement } from './element-resolver.js';
import { capturePageState } from './page-state.js';
import type { TargetPolicy } from '../policy/target-policy.js';

/** A valid grounding response can be retried once before dispatch when its target is not yet available. */
export class TargetNotReadyError extends TargetChangedError {
  constructor() { super('The intended target is not yet confidently identifiable. Observe the page again before dispatch.'); this.name = 'TargetNotReadyError'; }
}

/** Coordinates only ground an inspected DOM handle; they never dispatch a raw mouse click. */
export async function resolveVisualTarget(page: Page, plan: ActionPlan, observed: PageState, secrets: readonly string[], targetPolicy?: TargetPolicy): Promise<ResolvedElement | undefined> {
  if (!plan.point) return undefined;
  if (plan.framePath?.length) throw new ExecutionError('configuration', 'Use a semantic selector for a frame target.');
  const current = await capturePageState(page, undefined, secrets, targetPolicy);
  if (current.url !== observed.url || current.accessibilityTree !== observed.accessibilityTree || !current.screenshot.equals(observed.screenshot)
    || Date.now() - (observed.capturedAt ?? 0) > 30_000) throw new TargetChangedError('Stale computer-use observation; observe the page again.');
  const size = observed.imageSize; const viewport = observed.viewport;
  if (!size || !viewport || plan.point.x < 0 || plan.point.y < 0 || plan.point.x >= size.width || plan.point.y >= size.height) throw new ExecutionError('configuration', 'Computer-use point is outside the observed viewport.');
  const handle = await selectDOM(page.mainFrame(), 'visualTarget', { x: plan.point.x * viewport.width / size.width, y: plan.point.y * viewport.height / size.height });
  const element = handle;
  if (!element || !(await readDOM(element, 'visualInspectable'))) {
    await handle?.dispose(); throw new ExecutionError('configuration', 'Computer-use target has no inspectable DOM control. Describe an accessible target.');
  }
  return { handle: element as ResolvedElement['handle'], selector: 'visual-observation-only' };
}
