import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import type { Step } from '../parser/types.js';
import type { ActionExecution, StepResult } from '../../shared/contracts.js';
import type { ActionPlan, ActionResult, PageState } from './types.js';
import type { ExecutionMode, TargetPolicy } from '../policy/target-policy.js';
import type { ActionSafetyDecision, ActionSafetyEnvironment } from '../policy/action-safety.js';
import type { CredentialSession } from './credential-session.js';
import type { TargetIdentity } from './target-identity.js';
import type { DeterministicOutcome, OperatorStatus } from './operator-protocol.js';
import { ExecutionDeadlineError, ExecutionError } from '../engine/execution-error.js';
import { executeAction, type ExecuteActionPolicyOptions } from './action-executor.js';
import { resolveVisualTarget } from './visual-target.js';
import type { ResolvedElement } from './element-resolver.js';
import { capturePageState, captureScreenshot } from './page-state.js';
import { waitForGroundingOpportunity, waitForUsablePage } from './page-readiness.js';
import { NetworkRecorder } from './network-recorder.js';
import { TargetProgress } from './target-progress.js';
import { isAppFrame } from './frame-policy.js';
import { evaluateUrlAssertion } from './url-assertions.js';
import { evaluateNetworkAssertion } from './network-assertions.js';
import { IncompleteTextObservationError, parseVisibleTextAssertion, waitForVisibleText } from './text-assertions.js';
import { parseWaitDescription } from './wait-for-element.js';
import { isTransientObservationError } from './observation-recovery.js';
import { boundedRead, ReadDeadlineError } from './read-deadline.js';
import { CACHEABLE, qualifiedTargetBinding } from './authored-target.js';
import { redactText } from '../security/redaction.js';
import { DEFAULT_NEGATIVE_WINDOW_MS } from '../../shared/outcomes.js';

/** State one agent shares across the pages it drives: the repeat guard, the action count, whether anything
 * may have been written, the current step's evidence baselines and the target it resolved. */
export class OperatorState {
  readonly progress = new TargetProgress();
  actionSequence = 0;
  baselines = new Map<string, boolean>();
  target?: OperatorStatus['target'];
  private written = false;
  private readonly writeListeners: Array<() => void> = [];
  /** Sticky: once anything may have been written, it stays so for the run. Listeners hear the first time. */
  get mutation(): boolean { return this.written; }
  set mutation(value: boolean) {
    if (!value || this.written) return;
    this.written = true;
    for (const listener of this.writeListeners) listener();
  }
  onMutation(listener: () => void): void { this.writeListeners.push(listener); }
}

export interface OperatorOptions {
  targetPolicy?: TargetPolicy; secrets?: readonly string[]; credentials?: CredentialSession;
  logger?: (message: string) => void; signal?: AbortSignal;
  /** The run's outcome steps, which evidence refresh rereads. */
  assertions?: Step[];
}

/** Everything one action needs from the decision side. */
export interface ActRequest {
  step: Step; deadline: number; mode: ExecutionMode; environment: ActionSafetyEnvironment;
  /** Healing evidence observed before the action; refreshed in place before the final proofs. */
  before?: Map<string, boolean>;
  expectedIdentity?: TargetIdentity;
  /** Resolve the visual target from this observation. Grounding resolves before fixing the policy's timeouts;
   * the Act loop fixes them first. */
  resolveFrom?: { state: PageState; policyFirst: boolean };
  onExecution: (execution: ActionExecution) => void;
  onSafetyDecision: (decision: ActionSafetyDecision, durationMs: number) => void;
  /** The target was resolved: any later failure happened after execution started. */
  onResolved?: () => void;
}

/**
 * The browser side of a step: it observes, checks and dispatches, and decides nothing. The engine above it
 * (grounding, the step cache, AI assertions, healing) reaches the page only through these operations, each of
 * which runs between two decisions. Hosted runs use it in-process; the thin CLI will run it on the customer's
 * machine.
 */
export class PageOperator {
  private recorder?: NetworkRecorder;
  constructor(private readonly page: Page, private readonly state: OperatorState, private readonly options: OperatorOptions) {}

  /** Records requests (network assertions, settling) and notices writes that no button label reveals. */
  attach(): void {
    if (this.recorder) return;
    const recorder = new NetworkRecorder(); recorder.attach(this.page); this.recorder = recorder;
    // Also catch autosave/background writes that cannot be inferred from a button label.
    this.page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) this.state.mutation = true; });
  }
  get url(): string { return this.page.url(); }
  get closed(): boolean { return this.page.isClosed(); }
  assertCurrentUrl(): void { this.options.targetPolicy?.assertCurrentUrl(this.page.url()); }
  /** What the decision side reads after each operation. */
  status(): OperatorStatus {
    return { url: this.page.url(), closed: this.page.isClosed(), mutation: this.state.mutation, actionSequence: this.state.actionSequence,
      ...(this.state.target ? { target: this.state.target } : {}) };
  }
  /** A new step: no resolved target and no baselines yet. */
  beginStep(): void { this.state.target = undefined; this.state.baselines = new Map(); }
  resetProgress(): void { this.state.progress.reset(); }

  /** Where a cached hint would apply: the main frame's URL, and whether it is the app's own frame. */
  async location(): Promise<{ url: string; appFrame: boolean }> {
    this.options.signal?.throwIfAborted();
    const appFrame = !this.options.targetPolicy || await isAppFrame(this.page.mainFrame(), this.options.targetPolicy);
    return { url: this.page.url(), appFrame };
  }

  async observe(deadline: number, condition: boolean, onRetry: (error: unknown) => void): Promise<PageState> {
    if (condition && this.state.actionSequence > 0) await this.recorder?.settleAction(Math.min(deadline, Date.now() + Math.min(3_000, Math.floor((deadline - Date.now()) / 2))), this.options.signal);
    await waitForUsablePage(this.page, deadline, this.options.signal, condition ? 150 : 0, condition);
    return capturePageState(this.page, this.options.logger, this.options.secrets, this.options.targetPolicy, {
      timeoutMs: Math.max(1, deadline - Date.now()), signal: this.options.signal, onRetry,
    });
  }

  waitForGroundingOpportunity(deadline: number): Promise<void> { return waitForGroundingOpportunity(this.page, deadline, this.options.signal); }

  /** Step evidence: a masked screenshot of the page as it is now. */
  screenshot(timeoutMs: number): Promise<Buffer> { return captureScreenshot(this.page, timeoutMs, this.options.secrets ?? [], this.options.targetPolicy); }

  private resolveVisualTarget(plan: ActionPlan, observed: PageState): Promise<ResolvedElement | undefined> {
    return resolveVisualTarget(this.page, plan, observed, this.options.secrets ?? [], this.options.targetPolicy);
  }

  /** A deterministic outcome read once: true or false, or undefined when the step has no deterministic form. */
  async predicate(step: Step, deadline?: number, signal?: AbortSignal): Promise<boolean | undefined> {
    const argument = step.keyword === 'wait_for' ? parseWaitDescription(step.argument).cleanDescription : step.argument;
    const url = evaluateUrlAssertion(argument, this.page.url());
    if (url.matched) return url.passed;
    const visible = this.options.credentials?.literalAssertion(step, argument) ?? parseVisibleTextAssertion(argument, step.keyword === 'wait_for');
    if (visible) return waitForVisibleText(this.page, visible, 0, signal, this.options.targetPolicy, deadline);
    return undefined;
  }

  /** The outcome authored right after this step, read before its action, so a later transition can confirm a
   * repair. Unknown stays unknown. */
  async captureAdjacentBaseline(lineNumber: number, deadline: number): Promise<void> {
    this.state.baselines = new Map();
    const adjacent = this.options.assertions?.find(assertion => assertion.lineNumber === lineNumber + 1);
    if (!adjacent) return;
    try { const observed = await this.predicate(adjacent); if (observed !== undefined) this.state.baselines.set(adjacent.raw, observed); }
    catch (error) { if (!this.optionalReadFailed(error, deadline)) throw error; }
  }

  /** Every later outcome as it stands before grounding this step: healing evidence, not execution of Verify. */
  async readBaselines(lineNumber: number, deadline: number): Promise<Map<string, boolean>> {
    const before = new Map<string, boolean>();
    for (const assertion of this.options.assertions ?? []) {
      if (lineNumber >= 0 ? assertion.lineNumber <= lineNumber : assertion.lineNumber < 0 && assertion.lineNumber >= lineNumber) continue;
      try {
        // The adjacent baseline was already attempted. Unknown stays unknown;
        // do not reread it and silently upgrade optional evidence to absence.
        const observed = assertion.lineNumber === lineNumber + 1 ? this.state.baselines.get(assertion.raw) : await this.predicate(assertion);
        if (observed !== undefined) before.set(assertion.raw, observed);
      } catch (error) {
        // A loading frame makes it unknown; it can never confirm a transition.
        if (!this.optionalReadFailed(error, deadline)) throw error;
      }
    }
    return before;
  }

  /** An optional evidence read that may be left unknown, rather than failing the step. */
  private optionalReadFailed(error: unknown, deadline: number): boolean {
    return (error instanceof IncompleteTextObservationError || error instanceof ReadDeadlineError && Date.now() < deadline || isTransientObservationError(error))
      && !this.page.isClosed() && !this.options.signal?.aborted;
  }

  /** One validated action: resolve, authorize, re-prove and dispatch, then observe what happened. */
  async act(plan: ActionPlan, request: ActRequest): Promise<ActionResult> {
    const resolve = request.resolveFrom;
    let policy = resolve && !resolve.policyFirst ? undefined : this.policy(request);
    const groundedTarget = resolve ? await this.resolveVisualTarget(plan, resolve.state) : undefined;
    if (resolve) request.onResolved?.();
    policy ??= this.policy(request);
    return executeAction(this.page, plan, { ...policy,
      ...(request.expectedIdentity ? { expectedIdentity: request.expectedIdentity } : {}),
      ...(groundedTarget ? { groundedTarget } : {}) });
  }

  /** Polls a URL, network or quoted-text outcome in the browser until it holds or the deadline passes. */
  async deterministicOutcome(step: Step, argument: string, options: { start: number; deadline: number; stepTimeoutMs: number }): Promise<DeterministicOutcome | undefined> {
    const { deadline, start } = options, signal = this.options.signal, targetPolicy = this.options.targetPolicy;
    const url = evaluateUrlAssertion(argument, this.page.url());
    const network = evaluateNetworkAssertion(argument, this.recorder ?? null);
    if (url.matched || network.matched) {
      const predicate = () => url.matched ? evaluateUrlAssertion(argument, this.page.url()) : evaluateNetworkAssertion(argument, this.recorder ?? null);
      let outcome = url.matched ? url : network;
      while (!outcome.passed && Date.now() < deadline) {
        signal?.throwIfAborted();
        if (this.page.isClosed()) throw new Error('Browser page closed during assertion observation.');
        targetPolicy?.assertCurrentUrl(this.page.url());
        await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
        signal?.throwIfAborted();
        if (this.page.isClosed()) throw new Error('Browser page closed during assertion observation.');
        targetPolicy?.assertCurrentUrl(this.page.url());
        // A completed negative can exhaust the polling interval. Do not start
        // another predicate after its deadline and accept newly arrived truth.
        if (Date.now() >= deadline) break;
        outcome = predicate();
      }
      return { kind: url.matched ? 'url' : 'network', passed: !!outcome.passed, failure: outcome.reason ?? 'Expected browser outcome was not observed.' };
    }
    // Quoted visible text has a direct browser truth test, independent of model confidence.
    const visible = this.options.credentials?.literalAssertion(step, argument) ?? parseVisibleTextAssertion(argument, step.keyword === 'wait_for');
    if (!visible) return undefined;
    const timeoutMs = options.stepTimeoutMs;
    if (!visible.visible && step.keyword === 'verify' && visible.windowMs === undefined) visible.windowMs = DEFAULT_NEGATIVE_WINDOW_MS;
    if (!visible.visible && visible.absence !== 'throughout' && step.keyword === 'verify') await waitForUsablePage(this.page, deadline, signal);
    let observation: StepResult['observation'];
    const passed = await waitForVisibleText(this.page, visible, timeoutMs, signal, targetPolicy, deadline,
      windowMs => { observation = { kind: visible.absence === 'throughout' ? 'nonappearance' : 'absence', windowMs, match: visible.match ?? 'exact' }; }, step.keyword === 'wait_for' ? 'until' : 'window');
    return { kind: 'text', passed: !!passed, observation,
      failure: `Expected ${visible.match === 'phrase' ? 'phrase' : 'exact text'} "${visible.text}" to be ${visible.visible ? 'visible' : 'absent'} within ${observation?.windowMs ?? Math.min(timeoutMs, deadline - start)}ms.` };
  }

  /** Lets the repeat guard accept a confirmed outcome of the last activation. */
  async confirmProgress(assertion: Step, deadline: number): Promise<void> {
    const signal = this.options.signal;
    const argument = assertion.keyword === 'wait_for' ? parseWaitDescription(assertion.argument).cleanDescription : assertion.argument;
    const predicate = this.options.credentials?.literalAssertion(assertion, argument) ?? parseVisibleTextAssertion(argument, assertion.keyword === 'wait_for');
    if (predicate?.visible) await this.state.progress.confirm(assertion, predicate, this.state.actionSequence, {
      deadline, signal, check: () => {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new ExecutionDeadlineError('Step timed out before a validated action could complete.');
        if (this.page.isClosed()) throw new ExecutionError('infrastructure', 'Browser page closed during outcome confirmation.');
        this.options.targetPolicy?.assertCurrentUrl(this.page.url());
      },
    });
  }

  private async refreshEvidence(maps: Map<string, boolean>[], deadline: number, signal?: AbortSignal): Promise<void> {
    const eligible = new Map<string, Map<string, boolean>[]>();
    // Earlier true/unknown observations are an eligibility ceiling. Clear every
    // old false before reading, including entries we cannot refresh in budget.
    for (const map of maps) for (const [raw, value] of map) if (value === false) {
      eligible.set(raw, [...(eligible.get(raw) ?? []), map]); map.delete(raw);
    }
    const checkOwner = () => {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new ExecutionDeadlineError('Step timed out before a validated action could complete.');
      if (this.page.isClosed()) throw new ExecutionError('infrastructure', 'Browser page closed during evidence refresh.');
      this.options.targetPolicy?.assertCurrentUrl(this.page.url());
    };
    checkOwner();
    const started = Date.now();
    if (!eligible.size || deadline - started <= 250) return;
    const readDeadline = started + 250;
    const checkRead = () => { checkOwner(); if (Date.now() >= readDeadline) throw new ReadDeadlineError('Optional evidence refresh'); };
    for (const [raw, destinations] of eligible) {
      checkOwner();
      if (Date.now() >= readDeadline) return;
      const assertion = this.options.assertions?.find(candidate => candidate.raw === raw);
      if (!assertion) continue;
      try {
        const observed = await boundedRead(() => this.predicate(assertion, readDeadline, signal),
          { deadline: readDeadline, signal, label: 'Optional evidence refresh', check: checkRead });
        // No pending read may restore evidence after its budget/owner expires.
        if (observed === false) for (const map of destinations) map.set(raw, false);
      } catch (error) {
        checkOwner();
        if (!(error instanceof IncompleteTextObservationError || error instanceof ReadDeadlineError) && !isTransientObservationError(error)) throw error;
      }
    }
  }

  private policy(request: ActRequest): ExecuteActionPolicyOptions {
    const { step, before, deadline } = request;
    let preparedClick: Awaited<ReturnType<TargetProgress['prepare']>> | undefined;
    const signal = this.options.signal, baselines = this.state.baselines, progress = this.state.progress;
    return { mode: request.mode, environment: request.environment, rawStep: step.raw,
      targetPolicy: this.options.targetPolicy, secrets: this.options.secrets, credentials: this.options.credentials, credentialStep: step, signal,
      onSafetyDecision: request.onSafetyDecision,
      timeoutMs: Math.max(1, deadline - Date.now() - 25),
      deadline,
      preflightTimeoutMs: Math.max(1, Math.min(4_000, Math.floor((deadline - Date.now()) / 3))),
      logger: text => this.options.logger?.(redactText(text, this.options.secrets ?? [])),
      onExecution: execution => {
        if (execution.phase === 'not_dispatched' && preparedClick) { void preparedClick.handle.dispose().catch(() => {}); void preparedClick.scope?.dispose().catch(() => {}); preparedClick = undefined; }
        if (execution.phase === 'outcome_unknown') this.state.mutation = true;
        request.onExecution(execution);
      },
      beforeTargetInspection: handle => progress.wait(handle, deadline, signal),
      prepareEvidence: evidenceDeadline => this.refreshEvidence(before ? [baselines, before] : [baselines], evidenceDeadline, signal),
      prepareActivation: async handle => {
        const previous = preparedClick; preparedClick = undefined;
        await previous?.handle.dispose().catch(() => {}); await previous?.scope?.dispose().catch(() => {});
        preparedClick = await progress.prepare(handle, step.lineNumber, this.state.target?.identity.binding?.entity);
      },
      onActionDispatched: mutation => {
        this.state.actionSequence++;
        if (preparedClick) { progress.dispatched(preparedClick, this.state.actionSequence, this.state.baselines); preparedClick = undefined; }
        this.state.mutation ||= mutation || step.keyword === 'navigate_to';
        this.recorder?.markActionBoundary();
      },
      onResolvedTarget: (selector, identity, persistent = true) => {
        if (CACHEABLE.has(step.keyword) && qualifiedTargetBinding(step, identity, selector) === false) throw new ExecutionError('configuration', 'Ambiguous target: the proposed control does not belong to the authored entity or region.');
        this.state.target = { selector, identity, persistent };
      },
    };
  }
}
