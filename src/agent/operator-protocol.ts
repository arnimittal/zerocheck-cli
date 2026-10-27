import type { Step } from '../parser/types.js';
import type { ActionExecution, FailureKind, StepResult } from '../../shared/contracts.js';
import type { ActionPlan, PageState } from './types.js';
import type { ExecutionMode } from '../policy/target-policy.js';
import type { ActionSafetyDecision, ActionSafetyEnvironment } from '../policy/action-safety.js';
import type { TargetIdentity } from './target-identity.js';
import type { StepBindings } from './credential-session.js';
import { ExecutionDeadlineError, ExecutionError } from '../engine/execution-error.js';
import { ActionExecutionError } from './action-executor.js';
import { DisabledTargetError, NativeTargetDetachedError, SelectedTargetMismatchError, SelectorOvermatchError, TargetChangedError } from './target-errors.js';
import { TargetNotReadyError } from './visual-target.js';
import { ElementNotFoundError } from './element-resolver.js';
import { AssertionDeadlineError, IncompleteTextObservationError } from './text-assertions.js';
import { ReadDeadlineError } from './read-deadline.js';
import { NativeFrameDetachedError } from './frame-policy.js';
import { redactText } from '../security/redaction.js';

/*
 * The messages between the decision side (BrowserAgent, through OperatorClient) and the browser side (PageOperator,
 * through OperatorHost). Everything here is plain JSON: no element handles, callbacks, Maps or Buffers, and no
 * absolute times, because the two sides may run on different machines.
 */

/** Resets that cannot fail; they travel with the next operation and run before it. */
export type OperatorControl = 'beginStep' | 'resetProgress';
/** Which credential grants apply: login steps may use configured secret origins; setup and body steps may not. */
export type CredentialPhase = 'setup' | 'login' | 'body';
export const CREDENTIAL_PHASES: readonly CredentialPhase[] = ['setup', 'login', 'body'];
/** Outcome evidence by assertion text: true, false, or absent when unknown. */
export type Evidence = Array<[string, boolean]>;

export type Operation =
  | { kind: 'attach' }
  | { kind: 'assertCurrentUrl' }
  | { kind: 'location' }
  | { kind: 'observe'; budgetMs: number; condition: boolean }
  | { kind: 'waitForGroundingOpportunity'; budgetMs: number }
  | { kind: 'screenshot'; timeoutMs: number }
  | { kind: 'captureAdjacentBaseline'; lineNumber: number; budgetMs: number }
  | { kind: 'readBaselines'; lineNumber: number; budgetMs: number }
  | { kind: 'act'; plan: ActionPlan; step: Step; budgetMs: number; mode: ExecutionMode; environment: ActionSafetyEnvironment;
      before?: Evidence; expectedIdentity?: TargetIdentity;
      /** An observation this side returned, by reference; a newer observation makes it stale. */
      resolveFrom?: { observation: number; policyFirst: boolean } }
  | { kind: 'deterministicOutcome'; step: Step; argument: string; elapsedMs: number; budgetMs: number; stepTimeoutMs: number }
  | { kind: 'confirmProgress'; assertion: Step; budgetMs: number }
  /** Releases the repeat guard's element handles now, when no operation follows (a failed step, the end of a run). */
  | { kind: 'resetProgress' }
  // A check's session, set up and torn down one call at a time so each keeps the runner's own time bound.
  /** Begins a check's session. Its outcome steps travel with it, as the browser side needs them for evidence; so does
   * its credential binding table when the browser side holds the secret values. */
  | { kind: 'initialize'; assertions?: Step[]; bindings?: StepBindings[] }
  | { kind: 'newContext'; viewport: { width: number; height: number }; recordVideo: boolean }
  | { kind: 'prepareContext'; defaultTimeoutMs: number }
  | { kind: 'newPage' }
  | { kind: 'installNavigationGuard' }
  | { kind: 'watch' }
  | { kind: 'drainConsole' }
  | { kind: 'closeContext' }
  /** With `upload` (a thin CLI run), the CLI uploads the recording under that name in the run's artifacts, within
   * `budgetMs`. */
  | { kind: 'saveVideo'; upload?: string; budgetMs?: number }
  | { kind: 'releaseNavigationGuard' };

/** The phase travels with every request, so a lost request cannot leave a later step with login grants. */
export interface OperatorRequest { id: number; phase?: CredentialPhase; controls: OperatorControl[]; operation: Operation }

/** What the decision side may read about the browser side, as of the end of each operation. */
export interface OperatorStatus {
  url: string; closed: boolean; mutation: boolean; actionSequence: number;
  target?: { selector: string; identity: TargetIdentity; persistent: boolean };
  /** The session's latest refusal (policy) and guard failure (infrastructure), already redacted; never cleared. */
  denied?: string; failure?: string;
}

export type OperatorResponse = { id: number; status: OperatorStatus;
  /** For an action: its evidence, refreshed; and whether its target was resolved, after which a failure is not re-grounded. */
  before?: Evidence; resolved?: boolean }
  & ({ ok: true; value?: unknown } | { ok: false; error: ErrorEnvelope });

/** Sent while an operation runs, in order and before its response; `mutation` may come at any time. */
export type OperatorEvent =
  | { id: number; type: 'execution'; execution: ActionExecution }
  | { id: number; type: 'safety'; decision: ActionSafetyDecision; durationMs: number }
  | { id: number; type: 'retry'; error: ErrorEnvelope }
  | { type: 'mutation' }
  /** The session refused a request or popup (policy), or a guard failed (infrastructure). Already redacted. */
  | { type: 'denied' | 'failure'; message: string };

/** A reply as the CLI sends it over the network: the host's reply and, in order, every event since the last one. */
export interface RemoteReply { reply: OperatorResponse; events: OperatorEvent[] }

// The CLI's link to the instance: the CLI asks for work and reports what it did; the instance never calls the CLI.
export type RunEnd = 'passed' | 'failed' | 'cancelled' | 'interrupted';
export const RUN_ENDS: readonly RunEnd[] = ['passed', 'failed', 'cancelled', 'interrupted'];
/** `wait`: a long poll ended with no work yet, which is not a failure. `retire`: the operation with this id was
 * withdrawn because its check stopped before the CLI acknowledged it; the CLI runs nothing for it and moves on.
 * `waitedMs`: how long the instance held this request before handing the operation out, on the instance's clock, so the
 * CLI can tell the time its answer spent on the way from the time it waited for work. */
export type NextAnswer = { type: 'operation'; request: OperatorRequest; waitedMs: number } | { type: 'retire'; id: number } | { type: 'wait' } | { type: 'finished'; status: RunEnd; reason?: string };
/** The link's version: an instance refuses a CLI that speaks another, before anything runs. 2 added `retire`, 3 added
 * `waitedMs`. */
export const LINK_PROTOCOL = 3;

/** The operation `ms` later than its budget assumed: what is left of its budget (never below 0), and its elapsed time
 * grown to match, in whole milliseconds rounded towards less time. An act with no budget left is refused before it is
 * dispatched. */
export function delayed(operation: Operation, ms: number): Operation {
  const timed = operation as Operation & { budgetMs?: number; elapsedMs?: number };
  if (typeof timed.budgetMs !== 'number' || !(ms > 0)) return operation;
  const late = Math.ceil(ms);
  return { ...timed, budgetMs: Math.max(0, Math.floor(timed.budgetMs) - late), ...typeof timed.elapsedMs === 'number' ? { elapsedMs: timed.elapsedMs + late } : {} } as Operation;
}
/** Every message names the CLI's executor, so the instance can refuse a second one on the same run. */
export interface NextMessage { protocol: number; executor: string; after: number; reply?: RemoteReply }
export interface CancelMessage { protocol: number; executor: string; reason: string; after: number; reply?: RemoteReply }

export interface OperatorTransport {
  call(request: OperatorRequest): Promise<OperatorResponse>;
  onEvent(listener: (event: OperatorEvent) => void): void;
}

export type DeterministicOutcome =
  | { kind: 'url' | 'network'; passed: boolean; failure: string }
  | { kind: 'text'; passed: boolean; failure: string; observation: StepResult['observation'] };

export type WireObservation = Omit<PageState, 'screenshot'> & { screenshot: string; ref: number };

export type ErrorEnvelope =
  | { type: string; name: string; message: string; props?: Record<string, unknown>; cause?: ErrorEnvelope }
  | { type: 'value'; value: string };

/** The classes the decision side tells apart, most specific first. Any other error keeps its name and message
 * and becomes its nearest listed ancestor, so `instanceof` checks give the same answers on both sides. */
const ERRORS: Array<[string, new (...args: never[]) => Error]> = [
  ['ActionExecutionError', ActionExecutionError],
  ['TargetNotReadyError', TargetNotReadyError], ['SelectorOvermatchError', SelectorOvermatchError],
  ['NativeTargetDetachedError', NativeTargetDetachedError], ['ElementNotFoundError', ElementNotFoundError],
  ['TargetChangedError', TargetChangedError], ['DisabledTargetError', DisabledTargetError],
  ['SelectedTargetMismatchError', SelectedTargetMismatchError], ['IncompleteTextObservationError', IncompleteTextObservationError],
  ['AssertionDeadlineError', AssertionDeadlineError], ['ReadDeadlineError', ReadDeadlineError],
  ['ExecutionDeadlineError', ExecutionDeadlineError], ['ExecutionError', ExecutionError],
  ['NativeFrameDetachedError', NativeFrameDetachedError],
];
export const ERROR_TYPES = ERRORS.map(([type]) => type);
const FAILURE_KINDS: FailureKind[] = ['assertion', 'interaction', 'configuration', 'policy', 'infrastructure', 'cancelled'];
const PHASES: ActionExecution['phase'][] = ['not_dispatched', 'dispatched', 'completed', 'outcome_unknown'];
const EFFECTS: ActionExecution['effect'][] = ['observation', 'input', 'possible_write'];
/** The only error fields the decision side reads; nothing else crosses, so page data and prototypes cannot. */
const PROPS = ['failureKind', 'execution'] as const;

export function encodeError(error: unknown, depth = 0): ErrorEnvelope {
  if (!(error instanceof Error)) return { type: 'value', value: String(error) };
  const type = error instanceof DOMException ? 'DOMException' : ERRORS.find(([, type]) => error instanceof type)?.[0] ?? 'Error';
  const props: Record<string, unknown> = {};
  for (const key of PROPS) {
    try { const plain = JSON.stringify((error as Error & Record<string, unknown>)[key]); if (plain !== undefined) props[key] = JSON.parse(plain); } catch { /* not plain data */ }
  }
  return { type, name: error.name, message: error.message, ...(Object.keys(props).length ? { props } : {}),
    ...(error.cause !== undefined && depth < 8 ? { cause: encodeError(error.cause, depth + 1) } : {}) };
}

/**
 * Rebuilds an error with the same class, name, message, failure kind, execution and cause chain. Never throws: an
 * action error whose execution cannot be read becomes `outcome_unknown`, because the action may have run.
 */
export function decodeError(envelope: ErrorEnvelope): unknown {
  if (!envelope || typeof envelope !== 'object') return 'Unreadable error from the browser side.';
  if (envelope.type === 'value' || !('name' in envelope)) return 'value' in envelope ? String(envelope.value) : 'Unreadable error from the browser side.';
  const message = String(envelope.message);
  if (envelope.type === 'DOMException') return new DOMException(message, String(envelope.name));
  const type = ERRORS.find(([name]) => name === envelope.type)?.[1] ?? Error;
  const error = Reflect.construct(Error, [message], type) as Error;
  for (const key of PROPS) if (envelope.props && Object.hasOwn(envelope.props, key)) Object.defineProperty(error, key, { value: envelope.props[key], writable: true, enumerable: true, configurable: true });
  if (error.name !== envelope.name) error.name = String(envelope.name);
  if (envelope.cause) Object.defineProperty(error, 'cause', { value: decodeError(envelope.cause), writable: true, configurable: true });
  if ((error instanceof ExecutionError || error instanceof ActionExecutionError) && !FAILURE_KINDS.includes(error.failureKind as FailureKind)) {
    Object.assign(error, { failureKind: 'infrastructure' });
  }
  if (error instanceof ActionExecutionError && !isExecution(error.execution)) Object.assign(error, { execution: {
    action: 'unknown', phase: 'outcome_unknown', effect: 'possible_write', actionObserved: false, outcomeObserved: false, sources: [] } satisfies ActionExecution });
  return error;
}

/** A readable error, as opposed to a thrown value or a damaged envelope, down its cause chain. */
export function isErrorEnvelope(envelope: unknown, depth = 0): boolean {
  const value = envelope as { type?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') return false;
  if (value.type === 'value') return depth > 0 && typeof (value as { value?: unknown }).value === 'string';
  return typeof value.name === 'string' && typeof value.message === 'string' && depth < 9
    && (value.cause === undefined || isErrorEnvelope(value.cause, depth + 1));
}
export function isEvidence(value: unknown): value is Evidence {
  return Array.isArray(value) && value.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'boolean');
}

export function isExecution(value: unknown): value is ActionExecution {
  const execution = value as ActionExecution;
  return !!execution && typeof execution === 'object' && typeof execution.action === 'string' && PHASES.includes(execution.phase)
    && EFFECTS.includes(execution.effect) && typeof execution.actionObserved === 'boolean' && typeof execution.outcomeObserved === 'boolean'
    && Array.isArray(execution.sources) && execution.sources.every(source => typeof source === 'string');
}

/** Configured secret values never leave the browser side, in any message or cause. */
export function redactEnvelope(envelope: ErrorEnvelope, secrets: readonly string[]): ErrorEnvelope {
  if (!('name' in envelope)) return { type: 'value', value: redactText(String(envelope.value), secrets) };
  return { ...envelope, message: redactText(envelope.message, secrets), ...(envelope.cause ? { cause: redactEnvelope(envelope.cause, secrets) } : {}) };
}

export function encodeObservation(state: PageState, ref: number): WireObservation {
  return { ...state, screenshot: state.screenshot.toString('base64'), ref };
}
export function decodeObservation(wire: WireObservation): { state: PageState; ref: number } {
  const { ref, screenshot, ...rest } = wire;
  return { state: { ...rest, screenshot: Buffer.from(screenshot, 'base64') }, ref };
}
