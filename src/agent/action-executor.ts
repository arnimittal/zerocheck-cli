import { setTimeout as delay } from 'node:timers/promises';
import { readDOM, readDOMSnapshot, selectAllDOM, selectDOM, sameDOMNode } from './dom-reader.js';
import { keyActivatesControl, normalizeKey } from '../../shared/keyboard.js';
import { ExecutionError, ExecutionDeadlineError, abortFailureKind } from '../engine/execution-error.js';
import { TargetChangedError, DisabledTargetError, SelectedTargetMismatchError, NativeTargetDetachedError } from './target-errors.js';
import type { FailureKind } from '../../shared/contracts.js';
import { boundedRead, ReadDeadlineError } from './read-deadline.js';
import { targetReadiness, waitForTargetReady, waitForActiveTargetStable } from './target-readiness.js';
import type { ElementHandle, Page } from 'playwright';
import type { ActionExecution } from '../../shared/contracts.js';
import type { ActionPlan, ActionResult } from './types.js';
import { resolveElementWithSelector, type ResolvedElement } from './element-resolver.js';
import type { TargetPolicy, ExecutionMode } from '../policy/target-policy.js';
import { parseTimedWaitMs } from './wait-duration.js';
import { readTargetIdentity, sameTargetIdentity, type TargetIdentity } from './target-identity.js';
import { assertFrameAllowed, isAppFrame, NativeFrameDetachedError } from './frame-policy.js';
import { assertCredentialBoundary, assertSecretNavigationAllowed, containsConfiguredSecret } from './credential-boundary.js';
import type { CredentialSession } from './credential-session.js';
import type { Step } from '../parser/types.js';
import { parseStep } from '../parser/step-parser.js';
import { bindIntendedTarget } from './intended-target.js';
import { associatedPointerReceiver, revalidatePointerReceiver, type PointerReceiver } from './pointer-receiver.js';
import { readAccessibleName } from './accessible-name.js';
import {
  evaluateActionSafety,
  hasBulkRecipientDeclaration,
  type ActionSafetyDecision,
  type ActionSafetyEnvironment,
} from '../policy/action-safety.js';

export interface ExecuteActionPolicyOptions {
  mode: ExecutionMode;
  rawStep: string;
  targetPolicy?: TargetPolicy;
  environment?: ActionSafetyEnvironment;
  startUrl?: string;
  onSafetyDecision?: (decision: ActionSafetyDecision, durationMs: number) => void;
  onResolvedSelector?: (selector: string) => void;
  onResolvedTarget?: (selector: string, identity: TargetIdentity, persistent?: boolean) => void;
  expectedIdentity?: TargetIdentity;
  onActionDispatched?: (mutationPossible: boolean) => void;
  logger?: (message: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Absolute step deadline supplied by the trusted runner/controller. */
  deadline?: number;
  preflightTimeoutMs?: number;
  groundedTarget?: ResolvedElement;
  onExecution?: (execution: ActionExecution) => void;
  /** Trusted read-only revalidation; never supplied by a model or authored step. */
  beforeDispatch?: () => Promise<void>;
  /** Optional controller evidence, refreshed after settling and before final proofs. */
  prepareEvidence?: (deadline: number) => Promise<void>;
  beforeTargetInspection?: (handle: ElementHandle<SVGElement | HTMLElement>) => Promise<void>;
  prepareActivation?: (handle: ElementHandle<SVGElement | HTMLElement>) => Promise<void>;
  secrets?: readonly string[];
  credentials?: CredentialSession;
  credentialStep?: Step;
}

/** A failed preflight can be re-grounded; an uncertain dispatch must never be repeated. */
export class ActionExecutionError extends Error {
  constructor(message: string, readonly execution: ActionExecution, options?: ErrorOptions, readonly failureKind: FailureKind = options?.cause instanceof ExecutionError ? options.cause.failureKind : options?.cause instanceof ReadDeadlineError ? 'infrastructure' : 'interaction') {
    super(message, options); this.name = 'ActionExecutionError';
  }
}

/** Disabled targets cannot be replaced by an enabled namesake or ancestor. */
export function isDisabledActionabilityFailure(error: unknown): boolean {
  return error instanceof ActionExecutionError && error.execution.phase === 'not_dispatched'
    && error.cause instanceof DisabledTargetError;
}

export async function executeAction(page: Page, plan: ActionPlan, policy?: ExecuteActionPolicyOptions): Promise<ActionResult> {
  if (plan.action === 'press') plan = { ...plan, value: normalizeKey(plan.value).value };
  const start = Date.now();
  const timeout = Math.max(1, policy?.timeoutMs ?? 10_000);
  const deadline = Math.min(policy?.deadline ?? Infinity, start + timeout);
  const check = () => {
    policy?.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new ExecutionDeadlineError('Step timed out before a validated action could complete.');
  };
  const remaining = () => { check(); return Math.max(1, deadline - Date.now()); };
  const preflight = Math.min(timeout, policy?.preflightTimeoutMs ?? timeout);
  const execution: ActionExecution = { action: plan.action, phase: 'not_dispatched',
    effect: ['fill', 'select'].includes(plan.action) ? 'input' : ['click', 'press'].includes(plan.action) ? 'possible_write' : 'observation',
    actionObserved: false, outcomeObserved: false, sources: [] };
  const publish = () => policy?.onExecution?.({ ...execution, sources: [...execution.sources] });
  const dispatch = () => {
    check();
    execution.phase = 'dispatched'; publish();
    // Input is repeatable in the DOM, but its event handlers may autosave to a server.
    policy?.onActionDispatched?.(execution.effect !== 'observation');
  };
  const complete = (selector: string): ActionResult => {
    check();
    execution.phase = 'completed'; execution.actionObserved = true; publish();
    return { success: true, selector, duration: Date.now() - start, execution: { ...execution, sources: [...execution.sources] } };
  };
  publish();
  let resolved: InspectedResolvedElement | undefined;
  let credentialHandleTransferred = false;
  let clickLabel: ElementHandle<SVGElement | HTMLElement> | undefined;
  let pointerReceiver: PointerReceiver | undefined;
  let receiverMetadata: ElementMetadata | undefined;
  let dispatchedPlan = plan;
  let beforeInputMatched = false;
  let dispatchErrored = false;
  let nativeSelect: NativeSelectTarget | undefined;
  let replacementWitness: SelectReplacementWitness | undefined;
  let checkingActionability = false;
  let allowDigitGrouping = !containsConfiguredSecret(plan.value ?? '', policy?.secrets ?? []);
  let publicInput = allowDigitGrouping;
  try {
    policy?.signal?.throwIfAborted();
    if (policy?.credentials && policy.credentialStep) policy.credentials.assertStructure(policy.credentialStep, plan);
    for (const url of plan.framePath ?? []) if (!['about:blank', 'about:srcdoc'].includes(url)) policy?.targetPolicy?.assertCurrentUrl(url);
    if (plan.action === 'navigate') {
      const target = policy?.targetPolicy?.assertAllowed(plan.value || plan.selector, page.url()) ?? (plan.value || plan.selector);
      if (policy?.targetPolicy) assertSecretNavigationAllowed(target, policy.targetPolicy, policy.secrets ?? []);
      await assertInteractionAllowed(page, plan, policy, { proposedNavigationTarget: target });
      policy?.onResolvedSelector?.(target); dispatch();
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: remaining() });
      policy?.targetPolicy?.assertCurrentUrl(page.url());
      execution.outcomeObserved = page.url() === target; execution.sources.push('dom:navigation');
      return complete(target);
    }
    if (plan.action === 'wait') {
      policy?.targetPolicy?.assertCurrentUrl(page.url());
      const ms = parseTimedWaitMs(plan.value);
      let selector = plan.selector;
      if (ms !== null) {
        if (ms > timeout) throw new ExecutionDeadlineError('Authored wait exceeds the remaining step time budget.');
        await page.waitForTimeout(ms);
      }
      else {
        const target = await resolveElementWithSelector(page, plan, { waitForVisibleMs: remaining(), deadline, signal: policy?.signal });
        await assertOwningFrameAllowed(target.handle, policy);
        policy?.onResolvedSelector?.(target.selector); selector = target.selector;
      }
      execution.outcomeObserved = true; execution.sources.push('dom:visibility');
      return complete(selector);
    }
    resolved = await resolveInteractionElement(page, plan, policy, deadline);
    allowDigitGrouping &&= resolved.semanticIdentity.inputType !== 'password';
    if (plan.action === 'fill' && allowDigitGrouping) {
      const autocomplete = await readDOM(resolved.handle, 'autocomplete');
      allowDigitGrouping = !passwordAutocomplete(autocomplete);
    }
    if (plan.action === 'select' && await readDOM(resolved.handle, 'nodeName') !== 'SELECT') {
      nativeSelect = await inspectLabelSelect(page, resolved, policy, deadline);
    }
    const inputHandle = nativeSelect?.handle ?? resolved.handle;
    execution.sources.push('dom:identity');
    if (plan.action === 'click' && ['checkbox', 'radio'].includes(resolved.semanticIdentity.role) && await resolved.handle.isEnabled()) clickLabel = await nativeClickLabel(resolved.handle);
    if (plan.action === 'click' && !clickLabel) {
      pointerReceiver = await associatedPointerReceiver(resolved.handle, { scrollOwnSurface: true });
      if (pointerReceiver) {
        await assertOwningFrameAllowed(pointerReceiver.handle, policy);
        if (policy?.credentials && policy.credentialStep) await policy.credentials.authorize(pointerReceiver.handle, policy.credentials.materialize(policy.credentialStep, plan));
        else if (policy?.targetPolicy) await assertCredentialBoundary(pointerReceiver.handle, plan, policy.targetPolicy, policy.secrets ?? []);
        receiverMetadata = await assertInteractionAllowed(page, plan, policy, { bindingControl: resolved.semanticIdentity.binding?.control }, pointerReceiver.handle);
      }
    }
    checkingActionability = !pointerReceiver && ['click','hover','fill','select','press'].includes(plan.action);
    switch (plan.action) {
      case 'click':
        if (pointerReceiver) await revalidatePointerReceiver(resolved.handle, pointerReceiver);
        else await (clickLabel ?? resolved.handle).click({ trial: true, timeout: Math.min(preflight, remaining()) });
        break;
      case 'hover': await resolved.handle.hover({ trial: true, timeout: Math.min(preflight, remaining()) }); break;
      case 'fill':
        await resolved.handle.waitForElementState('visible', { timeout: Math.min(preflight, remaining()) });
        await resolved.handle.waitForElementState('editable', { timeout: Math.min(preflight, remaining()) });
        break;
      case 'select':
        await inputHandle.waitForElementState('visible', { timeout: Math.min(preflight, remaining()) });
        await inputHandle.waitForElementState('enabled', { timeout: Math.min(preflight, remaining()) });
        break;
      case 'press':
        await resolved.handle.waitForElementState('visible', { timeout: Math.min(preflight, remaining()) });
        await resolved.handle.waitForElementState('enabled', { timeout: Math.min(preflight, remaining()) }); break;
      case 'scroll': break;
      default: throw new ExecutionError('configuration', `Unsupported action type: ${plan.action}`);
    }
    checkingActionability = false;
    if (policy?.credentials && policy.credentialStep) {
      const action = policy.credentials.materialize(policy.credentialStep, plan);
      dispatchedPlan = action.plan;
      publicInput &&= action.names.length === 0 && !containsConfiguredSecret(dispatchedPlan.value ?? '', policy.secrets ?? []);
      allowDigitGrouping &&= action.names.length === 0 && !containsConfiguredSecret(dispatchedPlan.value ?? '', policy.secrets ?? []);
    }
    if (policy?.beforeDispatch) {
      await policy.beforeDispatch();
      policy.signal?.throwIfAborted();
      if (Date.now() - start >= timeout) throw new ExecutionDeadlineError('Target validation exceeded the remaining step time budget.');
    }
    let beforeUrl: string, beforeState: string;
    // Preparation can itself overlap a new view transition. Only a completed
    // same-target moving observation repeats this read-only cycle; no action,
    // replacement target or credential binding is attempted inside it.
    for (;;) {
      check();
      await replacementWitness?.dispose(); replacementWitness = undefined;
      await waitForActiveTargetStable(resolved.handle, deadline, policy?.signal);
      if (nativeSelect) await waitForActiveTargetStable(nativeSelect.handle, deadline, policy?.signal, true);
      await policy?.prepareEvidence?.(deadline);
      beforeUrl = page.url();
      beforeState = await controlState(resolved.handle);
      if (['fill', 'select'].includes(plan.action)) beforeInputMatched = await inputMatches(inputHandle, dispatchedPlan, allowDigitGrouping);
      if (plan.action === 'click' || plan.action === 'press' && keyActivatesControl(plan.value, resolved.identity.role, resolved.identity.inputType)) await policy?.prepareActivation?.(resolved.activationHandle ?? resolved.handle);
      if (clickLabel && !await resolved.handle.isEnabled()) throw new DisabledTargetError('Original element is disabled before native label activation.');
      if (clickLabel) {
        const associated = await selectDOM(clickLabel, 'labelControl');
        try { if (!associated || !await sameDOMNode(associated, resolved.handle)) throw new TargetChangedError('Native label association changed before dispatch.'); }
        finally { await associated?.dispose(); }
      }
      if (plan.action === 'select' && publicInput) {
        replacementWitness = await boundedRead(() => captureSelectReplacement(resolved!, check), { deadline, signal: policy?.signal, label: 'Select replacement baseline', check });
      }
      await assertResolvedElementIdentity(resolved, policy);
      await assertOwningFrameAllowed(resolved.handle, policy);
      if (nativeSelect) await assertLabelSelect(page, resolved, nativeSelect, policy);
      if (policy?.credentials && policy.credentialStep) {
        const action = policy.credentials.materialize(policy.credentialStep, plan);
        await policy.credentials.authorize(inputHandle, action);
      } else if (policy?.targetPolicy) await assertCredentialBoundary(inputHandle, plan, policy.targetPolicy, policy.secrets ?? []);
      if (pointerReceiver) {
        if (!await resolved.handle.isEnabled() || !await pointerReceiver.handle.isEnabled()) throw new DisabledTargetError('element is not enabled before pointer dispatch');
        await assertOwningFrameAllowed(pointerReceiver.handle, policy);
        if (policy?.credentials && policy.credentialStep) await policy.credentials.authorize(pointerReceiver.handle, policy.credentials.materialize(policy.credentialStep, plan));
        else if (policy?.targetPolicy) await assertCredentialBoundary(pointerReceiver.handle, plan, policy.targetPolicy, policy.secrets ?? []);
        if (!receiverMetadata || !sameElementIdentity(receiverMetadata, await readElementMetadata(pointerReceiver.handle, plan))) throw new TargetChangedError('Pointer receiver operation changed before dispatch.');
        await revalidatePointerReceiver(resolved.handle, pointerReceiver);
      }
      const ready = await targetReadiness(resolved.handle);
      if (!ready.active) throw new TargetChangedError('The target view changed before dispatch; observe the current view again.');
      const selectedReady = nativeSelect ? await targetReadiness(nativeSelect.handle, true) : undefined;
      if (selectedReady && !selectedReady.active) throw new TargetChangedError('The associated native select is no longer actionable.');
      check();
      if (!ready.moving && !selectedReady?.moving) break;
    }
    if (policy?.credentials && policy.credentialStep) {
      const action = policy.credentials.materialize(policy.credentialStep, plan);
      await policy.credentials.bindInput(inputHandle, action);
      credentialHandleTransferred = action.names.length > 0 && ['fill', 'select'].includes(action.plan.action);
    }
    dispatch();
    try {
    switch (plan.action) {
      case 'click':
        if (pointerReceiver) await page.mouse.click(pointerReceiver.point.x, pointerReceiver.point.y);
        else await (clickLabel ?? resolved.handle).click({ timeout: remaining() });
        break;
      case 'fill': await resolved.handle.fill(dispatchedPlan.value ?? '', { timeout: remaining() }); break;
      case 'select': await inputHandle.selectOption({ label: dispatchedPlan.value ?? '' }, { timeout: remaining() }); break;
      case 'hover': await resolved.handle.hover({ timeout: remaining() }); break;
      case 'scroll': await resolved.handle.scrollIntoViewIfNeeded({ timeout: remaining() }); break;
      case 'press': await resolved.handle.press(plan.value ?? 'Enter', { timeout: remaining() }); break;
    }
    } catch (error) { dispatchErrored = true; throw error; }
    policy?.signal?.throwIfAborted();
    policy?.targetPolicy?.assertCurrentUrl(page.url());
    if (plan.action === 'fill' || plan.action === 'select') {
      const observed = plan.action === 'select' ? await observeSelectedOption(page, resolved, nativeSelect, dispatchedPlan, policy, deadline, check, replacementWitness) : undefined;
      execution.outcomeObserved = observed ? observed.matched : await inputMatches(inputHandle, dispatchedPlan, allowDigitGrouping);
      if (observed?.replacement) execution.sources.push('dom:replacement-selected-option');
      execution.sources.push(plan.action === 'fill' ? 'dom:input-value' : 'dom:selected-option');
      if (!execution.outcomeObserved) throw new Error('The control did not retain the authored input value.');
    } else {
      const afterState = await controlState(resolved.handle).catch(() => null);
      execution.outcomeObserved = beforeUrl !== page.url() || (afterState !== null && beforeState !== afterState);
      if (beforeUrl !== page.url()) execution.sources.push('dom:navigation');
      else if (execution.outcomeObserved) execution.sources.push('dom:control-state');
    }
    return complete(resolved.selector);
  } catch (error) {
    // Only native frame retirement before dispatch can use the existing single
    // fresh grounding allowance. A failed/uncertain action is never replayed.
    if (execution.phase === 'not_dispatched' && !policy?.signal?.aborted && !page.isClosed() && !(error instanceof ExecutionError)
      && (error instanceof NativeFrameDetachedError || error instanceof Error && /^(?:frame|locator|elementHandle)\.[^\n]*: (?:Frame was detached|frame has been detached)/i.test(error.message))) error = new TargetChangedError('A frame detached before target validation completed. Observe the current page again.', { cause: error });
    if (checkingActionability && execution.phase === 'not_dispatched' && error instanceof Error && error.name === 'TimeoutError' && !(error instanceof ExecutionError) && !page.isClosed() && !policy?.signal?.aborted) {
      try {
        const enabled = resolved && await boundedRead(() => (nativeSelect?.handle ?? resolved!.handle).isEnabled(), { deadline, signal: policy?.signal, label: 'Actionability state confirmation', check: () => { policy?.signal?.throwIfAborted(); } });
        error = enabled === false ? new DisabledTargetError('The intended control became disabled before dispatch.', { cause: error })
          : new TargetChangedError('The intended control did not become actionable before dispatch.', { cause: error });
      } catch (observationError) { error = observationError instanceof ExecutionError ? observationError : new ExecutionError('infrastructure', 'Actionability could not be observed.', { cause: observationError }); }
    }
    if (execution.phase === 'not_dispatched' && error instanceof DisabledTargetError && !execution.sources.includes('dom:identity')) execution.sources.push('dom:identity');
    // Only a driver dispatch failure may reconcile. Policy, cancellation and
    // failed observations never turn into success via a later input read.
    if (dispatchErrored && !(error instanceof ExecutionError) && execution.phase === 'dispatched' && Date.now() < deadline && !policy?.signal?.aborted && !page.isClosed() && page.context().browser()?.isConnected() !== false && resolved && ['fill', 'select'].includes(plan.action) && !beforeInputMatched) {
      try {
        check(); policy?.targetPolicy?.assertCurrentUrl(page.url());
        const selected = plan.action === 'select' ? await observeSelectedOption(page, resolved, nativeSelect, dispatchedPlan, policy, deadline, check, replacementWitness) : undefined;
        const observed = selected ? selected.matched : await boundedRead(() => inputMatches(resolved!.handle, dispatchedPlan, allowDigitGrouping), { deadline, signal: policy?.signal, label: 'Input reconciliation', check });
        if (observed) {
          execution.outcomeObserved = true;
          if (selected?.replacement) execution.sources.push('dom:replacement-selected-option');
          execution.sources.push(plan.action === 'select' ? 'dom:selected-option' : 'dom:input-value', 'controller:read-only-reconciliation');
          return complete(resolved.selector);
        }
      } catch (observationError) { error = observationError; }
    }
    if (execution.phase === 'dispatched') execution.phase = 'outcome_unknown';
    publish();
    const failureKind = abortFailureKind(policy?.signal) ?? (page.isClosed() || page.context().browser()?.isConnected() === false || !(error instanceof ExecutionError) && (plan.action === 'navigate' || execution.phase === 'not_dispatched') ? 'infrastructure' : undefined);
    throw new ActionExecutionError(error instanceof Error ? error.message : String(error), { ...execution, sources: [...execution.sources] }, { cause: error }, failureKind);
  } finally {
    await replacementWitness?.dispose();
    await clickLabel?.dispose().catch(() => {});
    await pointerReceiver?.handle.dispose().catch(() => {});
    await resolved?.activationHandle?.dispose().catch(() => {});
    if (!credentialHandleTransferred || nativeSelect) await resolved?.handle.dispose().catch(() => {});
    if (!credentialHandleTransferred) await nativeSelect?.handle.dispose().catch(() => {});
  }
}

/** Native label activation keeps the original input as the identity and policy target. */
async function nativeClickLabel(control: ElementHandle<SVGElement | HTMLElement>): Promise<ElementHandle<SVGElement | HTMLElement> | undefined> {
  const handle = await selectDOM(control, 'clickLabel');
  return handle ?? undefined;
}

function passwordAutocomplete(value: string): boolean {
  return value.toLowerCase().split(/\s+/).some(token => ['current-password', 'new-password'].includes(token));
}

interface NativeSelectTarget {
  handle: ElementHandle<SVGElement | HTMLElement>;
  identity: TargetIdentity;
  metadata: ElementMetadata;
}
class DetachedInputError extends TargetChangedError {
  constructor() { super('The input detached before its retained value could be confirmed.'); }
}
class SelectAssociationChangedError extends TargetChangedError {
  constructor() { super('The native select association changed before its outcome could be confirmed.'); }
}

/** Keep the validated visible label as the semantic anchor, while
 * validating and dispatching to its exact native select rather than relying on
 * Playwright's implicit label retargeting after policy checks. */
async function inspectLabelSelect(page: Page, resolved: InspectedResolvedElement, policy: ExecuteActionPolicyOptions | undefined, deadline: number): Promise<NativeSelectTarget> {
  const handle = await selectDOM(resolved.handle, 'labelSelect');
  if (!handle) throw new ExecutionError('configuration', 'Select requires a native select or its own containing semantic label, without a different record or region.');
  try {
    await assertOwningFrameAllowed(handle, policy);
    if (policy?.credentials && policy.credentialStep) await policy.credentials.authorize(handle, policy.credentials.materialize(policy.credentialStep, resolved.plan));
    else if (policy?.targetPolicy) await assertCredentialBoundary(handle, resolved.plan, policy.targetPolicy, policy.secrets ?? []);
    await waitForTargetReady(handle, deadline, policy?.signal, true);
    const identity = await readTargetIdentity(handle, policy?.secrets);
    const metadata = await assertInteractionAllowed(page, resolved.plan, policy, {}, handle, true);
    const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
    if (identity.role !== 'combobox' || normalize(identity.name) !== normalize(resolved.semanticIdentity.name)) throw new SelectedTargetMismatchError('The native select does not match its authored semantic label.');
    return { handle, identity, metadata };
  } catch (error) { await handle.dispose().catch(() => {}); throw error; }
}

async function assertSelectAssociation(resolved: InspectedResolvedElement, selected: NativeSelectTarget): Promise<void> {
  const current = await selectDOM(resolved.handle, 'labelSelect');
  try { if (!current || !await sameDOMNode(current, selected.handle)) throw new SelectAssociationChangedError(); }
  finally { await current?.dispose(); }
}

async function assertLabelSelect(page: Page, resolved: InspectedResolvedElement, selected: NativeSelectTarget, policy?: ExecuteActionPolicyOptions): Promise<void> {
  await assertSelectAssociation(resolved, selected);
  await assertOwningFrameAllowed(selected.handle, policy);
  const ready = await targetReadiness(selected.handle, true);
  if (!ready.active || !await selected.handle.isEnabled()) throw new TargetChangedError('The associated native select is no longer actionable.');
  if (policy?.credentials && policy.credentialStep) await policy.credentials.authorize(selected.handle, policy.credentials.materialize(policy.credentialStep, resolved.plan));
  else if (policy?.targetPolicy) await assertCredentialBoundary(selected.handle, resolved.plan, policy.targetPolicy, policy.secrets ?? []);
  if (!sameTargetIdentity(selected.identity, await readTargetIdentity(selected.handle, policy?.secrets)) ||
      !sameElementIdentity(selected.metadata, await assertInteractionAllowed(page, resolved.plan, policy, {}, selected.handle, true))) throw new TargetChangedError('The associated native select identity or operation changed before dispatch.');
}

interface SelectReplacementWitness {
  ownership: Awaited<ReturnType<typeof readDOMSnapshot<'selectOwnership'>>>;
  ancestors: ElementHandle<SVGElement | HTMLElement>[];
  controls: ElementHandle<SVGElement | HTMLElement>[];
  dispose(): Promise<void>;
}

/** Native objects, not selectors or positions, associate a later read with the
 * dispatched input. Existing controls exposed in this document's light/open
 * shadow DOM cannot become evidence by moving into the owner after dispatch.
 * This does not claim knowledge of private detached nodes or other documents. */
async function captureSelectReplacement(resolved: InspectedResolvedElement, check: () => void): Promise<SelectReplacementWitness> {
  const ownership = await readDOMSnapshot(resolved.handle, 'selectOwnership');
  let ancestors: ElementHandle<SVGElement | HTMLElement>[] = [];
  let controls: ElementHandle<SVGElement | HTMLElement>[] = [];
  const dispose = async () => { await Promise.all([...ownership.nodes, ...ancestors, ...controls].map(node => node.dispose().catch(() => {}))); };
  try {
    check();
    if (!ownership.facts.connected) throw new TargetChangedError('The select ownership changed before dispatch.');
    if (!ownership.facts.hasForm) { ancestors = await selectAllDOM(ownership.nodes[1], 'ancestors'); check(); }
    controls = await selectAllDOM(ownership.nodes[0], 'selects'); check();
    return { ownership, ancestors, controls, dispose };
  } catch (error) { await dispose(); throw error; }
}

/** This is outcome observation only. It never changes resolved callbacks, binds
 * credentials, learns a replacement selector, or dispatches another action. */
async function observeSelectReplacement(page: Page, resolved: InspectedResolvedElement, selected: NativeSelectTarget | undefined, plan: ActionPlan, policy: ExecuteActionPolicyOptions | undefined, witness: SelectReplacementWitness, check: () => void): Promise<boolean> {
  const read = async <T>(work: () => Promise<T>): Promise<T> => { check(); const result = await work(); check(); return result; };
  let owner = witness.ownership.nodes[1];
  if (!await read(() => readDOM(owner, 'connected'))) {
    // A replaced field wrapper can retain its meaning under a surviving native
    // ancestor. Never widen beyond that pre-dispatch chain to a document search.
    if (witness.ownership.facts.hasForm) throw new TargetChangedError('The original select form no longer exists.');
    const surviving = [];
    for (const ancestor of witness.ancestors) {
      if (!await read(() => readDOM(ancestor, 'connected'))) continue;
      if (['BODY','HTML'].includes(await read(() => readDOM(ancestor, 'nodeName')))) break;
      surviving.push(ancestor); break;
    }
    if (!surviving.length) throw new TargetChangedError('The original select owner no longer exists.');
    owner = surviving[0];
  }
  const assertOwnership = async (anchor: ElementHandle<SVGElement | HTMLElement>) => {
    const current = await readDOMSnapshot(anchor, 'selectOwnership');
    try {
      check();
      if (!current.facts.connected || current.facts.hasForm !== witness.ownership.facts.hasForm || current.nodes.length !== witness.ownership.nodes.length) throw new TargetChangedError('The replacement select ownership changed.');
      if (!await read(() => sameDOMNode(current.nodes[0], witness.ownership.nodes[0]))) throw new TargetChangedError('The replacement select moved to another document.');
      if (current.facts.hasForm) {
        for (let index = 1; index < current.nodes.length; index++) if (!await read(() => sameDOMNode(current.nodes[index], witness.ownership.nodes[index]))) throw new TargetChangedError('The replacement select moved to another form.');
      } else {
        const chain = await selectAllDOM(anchor, 'ancestors');
        try {
          check(); let retained = false;
          for (const ancestor of chain) if (await read(() => sameDOMNode(ancestor, owner))) { retained = true; break; }
          if (!retained) throw new TargetChangedError('The replacement select moved outside its surviving owner.');
        } finally { await Promise.all(chain.map(node => node.dispose().catch(() => {}))); }
      }
    } finally { await Promise.all(current.nodes.map(node => node.dispose().catch(() => {}))); }
  };
  // A destroyed/stalled old document is unknown, never permission to rebind.
  if (!await read(() => readDOM(owner, 'connected'))) throw new TargetChangedError('The surviving select owner no longer exists.');
  const candidates = await selectAllDOM(owner, 'selects');
  const anchors: ElementHandle<SVGElement | HTMLElement>[] = [];
  const eligible: { control: ElementHandle<SVGElement | HTMLElement>; anchor: ElementHandle<SVGElement | HTMLElement> }[] = [];
  const validate = async (control: ElementHandle<SVGElement | HTMLElement>, anchor: ElementHandle<SVGElement | HTMLElement>) => {
    if ((await read(() => readDOM(selected?.handle ?? resolved.handle, 'inputValue'))).connected) throw new TargetChangedError('The original select returned while replacement evidence was being observed.');
    await assertOwnership(anchor);
    if (selected) {
      const associated = await selectDOM(anchor, 'labelSelect');
      try { check(); if (!associated || !await read(() => sameDOMNode(associated, control))) throw new TargetChangedError('The replacement select lost its semantic label association.'); }
      finally { await associated?.dispose().catch(() => {}); }
      if (!sameTargetIdentity(resolved.nativeIdentity, await read(() => readTargetIdentity(anchor, policy?.secrets)))) throw new TargetChangedError('The replacement semantic label changed meaning.');
    }
    const native = await read(() => readTargetIdentity(control, policy?.secrets));
    if (!sameTargetIdentity(selected?.identity ?? resolved.nativeIdentity, native)) throw new TargetChangedError('The replacement select changed meaning.');
    const semantic = policy?.rawStep ? await read(() => bindIntendedTarget(anchor, parseStep(policy.rawStep, 0), selected ? resolved.nativeIdentity : native, policy.targetPolicy)) : selected ? resolved.nativeIdentity : native;
    if (!sameTargetIdentity(resolved.semanticIdentity, semantic)) throw new TargetChangedError('The replacement select no longer matches the authored target.');
    for (const handle of selected ? [anchor, control] : [control]) {
      const ready = await read(() => targetReadiness(handle, selected !== undefined && handle === control));
      if (!ready.active || ready.moving) throw new TargetChangedError('The replacement select is not in a usable view.');
      await read(() => assertOwningFrameAllowed(handle, policy));
    }
    if (policy?.credentials && policy.credentialStep) await read(() => policy.credentials!.authorize(control, policy.credentials!.materialize(policy.credentialStep!, plan)));
    else if (policy?.targetPolicy) await read(() => assertCredentialBoundary(control, plan, policy.targetPolicy!, policy.secrets ?? []));
    if (!sameElementIdentity(selected?.metadata ?? resolved.identity, await read(() => assertInteractionAllowed(page, plan, policy, {}, control, Boolean(selected))))) throw new TargetChangedError('The replacement select operation changed.');
  };
  try {
    check();
    for (const control of candidates) {
      if (await read(() => control.evaluate((node, previous) => { for (let i = 0; i < previous.length; i++) if (node === previous[i]) return true; return false; }, witness.controls))) continue;
      // Forms can retain hidden render copies. A completed inactive observation
      // excludes them; failed reads stay unknown and every survivor is rechecked.
      if (!(await read(() => targetReadiness(control, selected !== undefined))).active) continue;
      const native = await read(() => readTargetIdentity(control, policy?.secrets));
      if (!sameTargetIdentity(selected?.identity ?? resolved.nativeIdentity, native)) continue;
      const anchor = selected ? await selectDOM(control, 'containingLabel') : control;
      if (selected && anchor) anchors.push(anchor);
      check(); if (!anchor) continue;
      await validate(control, anchor);
      eligible.push({ control, anchor });
    }
    if (eligible.length > 1) throw new TargetChangedError('Multiple replacement selects match the original target.');
    if (!eligible.length) return false;
    const { control, anchor } = eligible[0];
    if (!await read(() => inputMatches(control, plan))) return false;
    await validate(control, anchor);
    return await read(() => inputMatches(control, plan));
  } finally { await Promise.all([...candidates, ...anchors].map(node => node.dispose().catch(() => {}))); }
}

/** Poll read-only observations under the original deadline. A detached old
 * value never counts; replacement proof requires pre-dispatch native witnesses. */
async function observeSelectedOption(page: Page, resolved: InspectedResolvedElement, selected: NativeSelectTarget | undefined, plan: ActionPlan, policy: ExecuteActionPolicyOptions | undefined, deadline: number, check: () => void, witness?: SelectReplacementWitness): Promise<{ matched: boolean; replacement: boolean }> {
  const handle = selected?.handle ?? resolved.handle;
  for (;;) {
    const observed = await boundedRead(async () => {
      check(); policy?.targetPolicy?.assertCurrentUrl(page.url());
      try {
        const original = await readDOM(handle, 'inputValue'); check();
        if (!original.connected) throw new DetachedInputError();
        if (selected) { await assertSelectAssociation(resolved, selected); check(); }
        if (!original.selectedLabels.includes(plan.value ?? '')) return { matched: false, replacement: false };
        check();
        if (!sameTargetIdentity(selected?.identity ?? resolved.nativeIdentity, await readTargetIdentity(handle, policy?.secrets))) throw new TargetChangedError('The selected control meaning changed before its outcome could be confirmed.');
        check();
        if (selected) {
          if (!sameTargetIdentity(resolved.nativeIdentity, await readTargetIdentity(resolved.handle, policy?.secrets))) throw new TargetChangedError('The semantic label meaning changed before the selected outcome could be confirmed.');
          check(); await assertSelectAssociation(resolved, selected); check();
        }
        return { matched: await inputMatches(handle, plan), replacement: false };
      } catch (error) {
        if (!witness || !(error instanceof DetachedInputError || error instanceof SelectAssociationChangedError || error instanceof NativeTargetDetachedError)) throw error;
        // A known association/value boundary can race a rerender. Only a fresh
        // positive native detachment permits replacement observation; arbitrary
        // failed reads and changes to a still-connected original stay terminal.
        check(); const original = await readDOM(handle, 'inputValue'); check();
        if (original.connected) throw error;
        return { matched: await observeSelectReplacement(page, resolved, selected, plan, policy, witness, check), replacement: true };
      }
    }, { deadline, signal: policy?.signal, label: 'Selected option observation', check }).catch(error => {
      if (error instanceof ExecutionError || policy?.signal?.aborted || page.isClosed()) throw error;
      throw new ExecutionError('infrastructure', 'The selected option could not be observed.', { cause: error });
    });
    if (observed.matched) return observed;
    // Do not start another read when the normal polling interval exhausts the
    // budget. This completed, live mismatch remains an honest failed outcome.
    if (deadline - Date.now() <= 50) return { matched: false, replacement: false };
    await delay(50, undefined, { signal: policy?.signal });
    policy?.signal?.throwIfAborted();
    if (deadline - Date.now() <= 50) return { matched: false, replacement: false }; // No new observation was started.
  }
}

/** Only observed values leave the page; expected credentials never enter its JavaScript. */
async function inputMatches(handle: ElementHandle<SVGElement | HTMLElement>, plan: ActionPlan, allowDigitGrouping = false): Promise<boolean> {
  const observed = await readDOM(handle, 'inputValue');
  if (!observed.connected) throw new DetachedInputError();
  const expected = plan.value ?? '';
  if (plan.action === 'select') return observed.tag === 'SELECT' && observed.selectedLabels.includes(expected);
  if (observed.value === expected) return true;
  if (!allowDigitGrouping || plan.action !== 'fill' || observed.tag !== 'INPUT' || observed.type === 'password' || passwordAutocomplete(observed.autocomplete)) return false;
  // Public numeric input may add internal ASCII spaces only. Never normalize
  // credential/password values, punctuation, leading zeros or other whitespace.
  const groupedDigits = /^[0-9]+(?: +[0-9]+)*$/;
  return typeof observed.value === 'string' && groupedDigits.test(observed.value) && groupedDigits.test(expected)
    && observed.value.replace(/ /g, '') === expected.replace(/ /g, '');
}
async function controlState(handle: ElementHandle<SVGElement | HTMLElement>): Promise<string> {
  return readDOM(handle, 'controlState');
}

/** Exact document-order native default submitter, including image inputs and a disabled first submitter. */
async function nativeActivationTarget(handle: ElementHandle<SVGElement | HTMLElement>, plan: ActionPlan): Promise<ElementHandle<SVGElement | HTMLElement> | undefined> {
  if (plan.action !== 'press' || !normalizeKey(plan.value).enter) return undefined;
  const value = await selectDOM(handle, 'activationTarget');
  return value ?? undefined;
}

async function resolveInteractionElement(
  page: Page,
  plan: ActionPlan,
  policy: ExecuteActionPolicyOptions | undefined,
  deadline: number,
): Promise<InspectedResolvedElement> {
  const resolved = policy?.groundedTarget ?? await resolveElementWithSelector(page, plan, { deadline, signal: policy?.signal, waitForVisibleMs: Math.max(1, Math.min(4_000, Math.floor((deadline - Date.now()) / 3))) });
  if (plan.action === 'click' && policy?.groundedTarget) {
    const ownControl = await selectDOM(resolved.handle, 'ownControl');
    const control = ownControl;
    if (control && !await control.evaluate((element, original) => element === original, resolved.handle)) { await resolved.handle.dispose(); resolved.handle = control; }
    else await ownControl?.dispose();
  }
  await assertOwningFrameAllowed(resolved.handle, policy);
  if (policy?.credentials && policy.credentialStep) await policy.credentials.authorize(resolved.handle, policy.credentials.materialize(policy.credentialStep, plan));
  if (policy?.targetPolicy && !policy.credentials) await assertCredentialBoundary(resolved.handle, plan, policy.targetPolicy, policy.secrets ?? []);
  if (policy?.expectedIdentity && policy.targetPolicy) {
    const owner = await resolved.handle.ownerFrame();
    if (!owner || !await isAppFrame(owner, policy.targetPolicy)) throw new TargetChangedError('Cached target moved outside its application frame.');
  }
  await waitForTargetReady(resolved.handle, deadline, policy?.signal);
  if (plan.action === 'click') await policy?.beforeTargetInspection?.(resolved.handle);
  const activationHandle = await nativeActivationTarget(resolved.handle, plan);
  try {
  let semanticIdentity = await readTargetIdentity(resolved.handle, policy?.secrets);
  if (plan.action === 'press' && keyActivatesControl(plan.value, semanticIdentity.role, semanticIdentity.inputType) && policy?.beforeTargetInspection) {
    await policy.beforeTargetInspection(activationHandle ?? resolved.handle);
    semanticIdentity = await readTargetIdentity(resolved.handle, policy.secrets);
  }
  if (['click', 'press', 'select'].includes(plan.action) && !await resolved.handle.isEnabled()) {
    try { await boundedRead(() => resolved.handle.waitForElementState('enabled', { timeout: Math.max(1, deadline - Date.now() - 100) }), { deadline, signal: policy?.signal, label: 'Control enabled state', check: () => { policy?.signal?.throwIfAborted(); } }); }
    catch (error) {
      policy?.signal?.throwIfAborted();
      if (error instanceof ExecutionError) throw error;
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw new ExecutionError('infrastructure', 'The control enabled state could not be observed.', { cause: error });
      const enabled = await boundedRead(() => resolved.handle.isEnabled(), { deadline, signal: policy?.signal, label: 'Control enabled state confirmation', check: () => { policy?.signal?.throwIfAborted(); } });
      if (!enabled) throw new DisabledTargetError('The intended control stayed disabled within the step deadline.', { cause: error });
    }
    await assertOwningFrameAllowed(resolved.handle, policy);
  }
  if (plan.action === 'click' && !semanticIdentity.interactive && !['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'textbox', 'combobox', 'summary'].includes(semanticIdentity.role)) throw new ExecutionError('configuration', 'Unsupported click target: select the actual intended control, not an ancestor or container.');
  const nativeIdentity = semanticIdentity;
  if (policy?.rawStep) {
    try { semanticIdentity = await bindIntendedTarget(resolved.handle, parseStep(policy.rawStep, 0), semanticIdentity, policy.targetPolicy); }
    catch (error) { if (policy.expectedIdentity && error instanceof SelectedTargetMismatchError) throw new TargetChangedError('Cached target meaning changed before interaction.', {cause:error}); throw error; }
  }
  if (policy?.expectedIdentity && !sameTargetIdentity(policy.expectedIdentity, semanticIdentity)) throw new TargetChangedError('Cached target meaning changed before interaction.');
  policy?.onResolvedSelector?.(resolved.selector);
  const owner = await resolved.handle.ownerFrame();
  const persistent = !policy?.targetPolicy || Boolean(owner && await isAppFrame(owner, policy.targetPolicy));
  policy?.onResolvedTarget?.(resolved.selector, semanticIdentity, persistent);
  const identity = await assertInteractionAllowed(
    page,
    plan,
    policy,
    { bindingControl: semanticIdentity.binding?.control },
    resolved.handle,
  );
  const activationIdentity = activationHandle ? await assertInteractionAllowed(page, { ...plan, action: 'click' }, policy, {}, activationHandle) : undefined;
  return { ...resolved, identity, semanticIdentity, nativeIdentity, plan, activationHandle, activationIdentity };
  } catch (error) { await activationHandle?.dispose().catch(() => {}); await resolved.handle.dispose().catch(() => {}); throw error; }
}

interface InspectedResolvedElement extends ResolvedElement {
  plan: ActionPlan;
  identity: ElementMetadata;
  semanticIdentity: TargetIdentity;
  nativeIdentity: TargetIdentity;
  activationHandle?: ElementHandle<SVGElement | HTMLElement>;
  activationIdentity?: ElementMetadata;
}

async function assertResolvedElementIdentity(resolved: InspectedResolvedElement, policy?: ExecuteActionPolicyOptions): Promise<void> {
  if (resolved.activationHandle) {
    const current = await nativeActivationTarget(resolved.handle, resolved.plan);
    try {
      if (!current || !await current.evaluate((element, previous) => element === previous, resolved.activationHandle) || !resolved.activationIdentity || !sameElementIdentity(resolved.activationIdentity, await readElementMetadata(current, { ...resolved.plan, action: 'click' }))) throw new TargetChangedError('Native submitter changed before keyboard activation.');
    } finally { await current?.dispose(); }
  }
  const readiness = await targetReadiness(resolved.handle);
  if (!readiness.active) throw new TargetChangedError('The target view changed before dispatch; observe the current view again.');
  const current = await readElementMetadata(resolved.handle, resolved.plan).catch(() => null);
  let identity = await readTargetIdentity(resolved.handle, policy?.secrets);
  if (policy?.rawStep) {
    try { identity = await bindIntendedTarget(resolved.handle, parseStep(policy.rawStep, 0), identity, policy.targetPolicy); }
    catch (error) { if (error instanceof SelectedTargetMismatchError) throw new TargetChangedError('Resolved target meaning changed before dispatch.', {cause:error}); throw error; }
  }
  if (!sameTargetIdentity(resolved.semanticIdentity, identity)) throw new TargetChangedError('Resolved target context changed before dispatch.');
  if (!current?.connected) throw new TargetChangedError('Resolved element detached before interaction');
  if (!sameElementIdentity(resolved.identity, current)) {
    throw new TargetChangedError('Resolved element identity changed after safety inspection');
  }
}

async function assertInteractionAllowed(
  page: Page,
  plan: ActionPlan,
  policy: ExecuteActionPolicyOptions | undefined,
  extra: { proposedNavigationTarget?: string; bindingControl?: string } = {},
  element?: ElementHandle<SVGElement | HTMLElement>,
  nativeSelectLabel = false,
): Promise<ElementMetadata> {
  const meta = element ? await readElementMetadata(element, plan, nativeSelectLabel) : EMPTY_ELEMENT_METADATA;
  if (element && !meta.connected) {
    throw new TargetChangedError('Resolved element detached before safety inspection');
  }
  if (!policy) return meta;
  if (meta.href && /^(https?:|\/)/.test(meta.href)) policy.targetPolicy?.assertAllowed(meta.href, page.url());
  const safetyStarted = performance.now();
  const decision = evaluateActionSafety({
    environment: policy.environment ?? 'unknown',
    currentUrl: page.url(),
    startUrl: policy.startUrl ?? page.url(),
    actionType: plan.action,
    role: meta.role,
    name: meta.name,
    label: extra.bindingControl ?? meta.labels ?? meta.name ?? meta.text,
    text: meta.text,
    href: meta.href,
    inputType: meta.inputType,
    labels: meta.labels,
    placeholder: meta.placeholder,
    formPurpose: meta.formPurpose,
    confirmationContext: meta.confirmationContext,
    submitterName: meta.submitterName,
    formAction: meta.formAction,
    isSubmission: meta.isSubmission,
    nativeDialogDismissal: meta.nativeDialogDismissal,
    selectedOption: meta.selectedOption,
    bulkScope: meta.bulkScope,
    proposedValue: plan.value,
    proposedNavigationTarget: extra.proposedNavigationTarget,
  });
  policy.onSafetyDecision?.(decision, performance.now() - safetyStarted);
  if (decision.verdict === 'deny') {
    throw new ExecutionError('policy', `ActionSafetyPolicy denied ${plan.action}: ${decision.reason}`);
  }
  if (decision.verdict === 'log') {
    policy.logger?.(`[policy] ${decision.category}: ${decision.reason}`);
  }
  meta.mutationPossible = decision.sideEffect === true;
  // The single final target/operation proof below actionability performs this
  // comparison immediately before dispatch, including after beforeDispatch.
  return meta;
}

function sameElementIdentity(before: ElementMetadata, after: ElementMetadata): boolean {
  return before.role === after.role &&
    before.name === after.name &&
    before.text === after.text &&
    before.href === after.href &&
    before.inputType === after.inputType &&
    before.labels === after.labels &&
    before.placeholder === after.placeholder &&
    before.formPurpose === after.formPurpose &&
    before.confirmationContext === after.confirmationContext &&
    before.submitterName === after.submitterName && before.formAction === after.formAction &&
    before.isSubmission === after.isSubmission && before.nativeDialogDismissal === after.nativeDialogDismissal && before.selectedOption === after.selectedOption &&
    before.bulkScope === after.bulkScope &&
    before.inForm === after.inForm;
}

/** Complete operation facts: Node-private, never persisted, logged or sent to a model. */
interface ElementMetadata {
  connected: boolean;
  role: string | null;
  name: string | null;
  text: string | null;
  href: string | null;
  inputType: string | null;
  labels: string | null;
  placeholder: string | null;
  formPurpose: string | null;
  confirmationContext: string | null;
  inForm: boolean;
  mutationPossible: boolean;
  submitterName?: string;
  formAction?: string;
  isSubmission?: boolean;
  nativeDialogDismissal?: boolean;
  selectedOption?: string;
  bulkScope?: boolean;
}

const EMPTY_ELEMENT_METADATA: ElementMetadata = {
  connected: true,
  role: null,
  name: null,
  text: null,
  href: null,
  inputType: null,
  labels: null,
  placeholder: null,
  formPurpose: null,
  confirmationContext: null,
  inForm: false,
  mutationPossible: false,
};

async function readElementMetadata(
  handle: ElementHandle<SVGElement | HTMLElement>,
  plan?: ActionPlan,
  nativeSelectLabel = false,
): Promise<ElementMetadata> {
  const pressKey = normalizeKey(plan?.value);
  const raw = await readDOM(handle, 'operationMetadata', { activating: plan?.action === 'click' || plan?.action === 'press' && pressKey.activation,
    implicitSubmitRequested: plan?.action === 'press' && pressKey.enter });
  const { optionLabels, recipientContext, ...metadata } = raw;
  const operation: ElementMetadata = metadata;
  // Only the exact contained native SELECT of a validated semantic
  // label uses its native label facts: AX-excluded selects have no AX root. Its
  // native name and ownership are checked against that visible label separately.
  if (!nativeSelectLabel) operation.name = await readAccessibleName(handle, operation.role, operation.name ?? undefined);
  // Retain only the explicit recipient count, not unrelated dialog prose, as
  // a bulk fact for an actual sending control. Raw text remains Node-private.
  if (/\b(?:send|email|invite|notify|broadcast)\b/i.test(operation.name ?? '') && hasBulkRecipientDeclaration(recipientContext)) operation.bulkScope = true;
  if (operation.isSubmission) {
    if (operation.role === 'button' && ['submit', 'image'].includes(operation.inputType ?? '')) operation.submitterName = operation.name ?? undefined;
    else {
      const submitter = await selectDOM(handle, 'submitter');
      try {
        const control = submitter;
        operation.submitterName = control ? await readAccessibleName(control as ElementHandle<SVGElement | HTMLElement>, 'button') : undefined;
      } finally { await submitter?.dispose(); }
    }
  }
  operation.selectedOption = plan?.action === 'select' ? optionLabels.find(label => label === plan.value) : undefined;
  return operation;
}

async function assertOwningFrameAllowed(handle: ElementHandle<SVGElement | HTMLElement>, policy?: ExecuteActionPolicyOptions): Promise<void> {
  if (!policy?.targetPolicy) return;
  const frame = await handle.ownerFrame();
  if (!frame) throw new ExecutionError('policy', 'TargetPolicy cannot establish the target owning document.');
  await assertFrameAllowed(frame, policy.targetPolicy);
}
