import type { Page } from 'playwright';
import { OperatorState, PageOperator, type OperatorOptions } from './page-operator.js';
import { BrowserSession, type SessionEnvironment } from './browser-session.js';
import { TargetChangedError } from './target-errors.js';
import { ExecutionError } from '../engine/execution-error.js';
import type { PageState } from './types.js';
import type { Step } from '../parser/types.js';
import type { CredentialSession, StepBindings } from './credential-session.js';
import { CREDENTIAL_PHASES, encodeError, encodeObservation, redactEnvelope, type Operation, type OperatorEvent, type OperatorRequest, type OperatorResponse,
  type OperatorStatus, type OperatorTransport } from './operator-protocol.js';

/**
 * The browser side of the operator protocol: it answers plain requests with a PageOperator and reports each
 * operation's events, its result or error, and the status the decision side may read. Hosted runs use it in this
 * process (`inProcessOperators`); the thin CLI will run it on the customer's machine, so it enforces its own rules:
 * it refuses anything it does not know and drives the page only once its session is guarded. Errors leave it
 * redacted; observations and console logs are redacted where they are captured.
 */
export class OperatorHost {
  private observation?: { ref: number; state: PageState };
  private observations = 0;
  private page?: PageOperator;
  private session?: BrowserSession;
  private readonly sessions?: () => CheckSession;
  /** With a page, the host drives it. With a session, it opens the page itself. With a session factory (the thin
   * CLI), each check's `initialize` begins a fresh session, with its own credential session, once the previous one has
   * finished. */
  constructor(private state: OperatorState, private readonly options: OperatorOptions, private readonly emit: (event: OperatorEvent) => void,
    target: { page: Page } | { session: BrowserSession } | { sessions: () => CheckSession }) {
    if ('page' in target) this.page = new PageOperator(target.page, state, options);
    else if ('session' in target) this.session = target.session;
    else this.sessions = target.sessions;
    state.onMutation(() => emit({ type: 'mutation' }));
  }
  /** A new check: a fresh session, credential session, page and state, as a hosted check gets from a fresh host. The
   * instance has moved on from the previous check, so a session of it still open (its cleanup timed out there) is
   * closed now. */
  private beginCheck(assertions: Step[] | undefined, bindings: StepBindings[] | undefined): void {
    if (assertions) this.options.assertions = assertions;
    const current = this.session?.settled;
    if (this.sessions && current !== 'unused') {
      if (current) void this.session!.closeContext().catch(() => {});
      const next = this.sessions();
      this.session = next.session; this.options.credentials = next.credentials; this.page = undefined; this.observation = undefined;
      this.state = new OperatorState(); this.state.onMutation(() => this.emit({ type: 'mutation' }));
    }
    if (bindings?.length) {
      if (!this.options.credentials) throw new ExecutionError('configuration', 'This run needs test secrets, and none are set on this machine.');
      this.options.credentials.importBindings(bindings);
    }
  }
  private get operator(): PageOperator {
    this.session?.requireReady();
    if (!this.page) throw new ExecutionError('infrastructure', 'No browser page is open.');
    return this.page;
  }
  private get browser(): BrowserSession { if (!this.session) throw new ExecutionError('infrastructure', 'This browser side has no session.'); return this.session; }
  private status(): OperatorStatus {
    const status = this.page?.status() ?? { url: '', closed: false, mutation: this.state.mutation, actionSequence: this.state.actionSequence };
    const { denied, failure } = this.session ?? {};
    // The URL stays as it is: the step cache keys hints by it, together with `location`.
    return { ...status, ...denied ? { denied } : {}, ...failure ? { failure } : {} };
  }
  private get secrets(): readonly string[] { return this.options.secrets ?? []; }
  private encode(error: unknown) { return redactEnvelope(encodeError(error), this.secrets); }

  async handle(request: OperatorRequest): Promise<OperatorResponse> {
    const { id, operation } = request;
    const before = operation.kind === 'act' && operation.before ? new Map(operation.before) : undefined;
    const act = { resolved: false };
    const evidence = () => ({ ...before ? { before: [...before] } : {}, ...act.resolved ? { resolved: true } : {} });
    try {
      if (request.phase !== undefined) {
        if (!CREDENTIAL_PHASES.includes(request.phase)) throw new ExecutionError('infrastructure', 'Unknown credential phase.');
        this.options.credentials?.beginPhase(request.phase);
      }
      for (const control of request.controls) {
        if (control === 'beginStep') this.operator.beginStep();
        else if (control === 'resetProgress') this.operator.resetProgress();
        else throw new ExecutionError('infrastructure', 'Unknown browser control.');
      }
      const value = await this.run(id, operation, before, act);
      return { id, ok: true, ...(value === undefined ? {} : { value }), status: this.status(), ...evidence() };
    } catch (error) {
      return { id, ok: false, error: this.encode(error), status: this.status(), ...evidence() };
    }
  }

  private async run(id: number, operation: Operation, before: Map<string, boolean> | undefined, act: { resolved: boolean }): Promise<unknown> {
    const deadline = (budgetMs: number) => Date.now() + budgetMs;
    switch (operation.kind) {
      case 'attach': return this.operator.attach();
      case 'assertCurrentUrl': return this.operator.assertCurrentUrl();
      case 'location': return this.operator.location();
      case 'observe': {
        this.observation = undefined;
        const state = await this.operator.observe(deadline(operation.budgetMs), operation.condition, error => this.emit({ id, type: 'retry', error: this.encode(error) }));
        this.observation = { ref: ++this.observations, state };
        return encodeObservation(state, this.observation.ref);
      }
      case 'waitForGroundingOpportunity': return this.operator.waitForGroundingOpportunity(deadline(operation.budgetMs));
      case 'screenshot': return (await this.operator.screenshot(operation.timeoutMs)).toString('base64');
      case 'captureAdjacentBaseline': return this.operator.captureAdjacentBaseline(operation.lineNumber, deadline(operation.budgetMs));
      case 'readBaselines': return [...await this.operator.readBaselines(operation.lineNumber, deadline(operation.budgetMs))];
      case 'act': {
        const { plan, step, mode, environment, expectedIdentity, resolveFrom } = operation;
        // Only the latest observation can be resolved; anything older is a changed target, refused before dispatch.
        const observed = resolveFrom && this.observation?.ref === resolveFrom.observation ? this.observation.state : undefined;
        if (resolveFrom && !observed) throw new TargetChangedError('Stale observation: the page was observed again before this action.');
        return this.operator.act(plan, { step, deadline: deadline(operation.budgetMs), mode, environment, before,
          ...(expectedIdentity ? { expectedIdentity } : {}),
          ...(resolveFrom && observed ? { resolveFrom: { state: observed, policyFirst: resolveFrom.policyFirst } } : {}),
          onExecution: execution => this.emit({ id, type: 'execution', execution }),
          onSafetyDecision: (decision, durationMs) => this.emit({ id, type: 'safety', decision, durationMs }),
          onResolved: () => { act.resolved = true; },
        });
      }
      case 'deterministicOutcome': {
        const now = Date.now();
        return this.operator.deterministicOutcome(operation.step, operation.argument,
          { start: now - operation.elapsedMs, deadline: now + operation.budgetMs, stepTimeoutMs: operation.stepTimeoutMs });
      }
      case 'confirmProgress': return this.operator.confirmProgress(operation.assertion, deadline(operation.budgetMs));
      case 'resetProgress': return this.operator.resetProgress();
      case 'initialize': this.beginCheck(operation.assertions, operation.bindings); return this.browser.initialize();
      case 'newContext': return this.browser.newContext({ viewport: operation.viewport, recordVideo: operation.recordVideo });
      case 'prepareContext': return this.browser.prepareContext(operation.defaultTimeoutMs);
      case 'newPage': this.page = new PageOperator(await this.browser.newPage(), this.state, this.options); return;
      case 'installNavigationGuard': return this.browser.installNavigationGuard();
      case 'watch': return this.browser.watch();
      case 'drainConsole': return this.browser.drainConsole();
      case 'closeContext': return this.browser.closeContext();
      case 'saveVideo': return this.browser.saveVideo();
      case 'releaseNavigationGuard': return this.browser.releaseNavigationGuard();
      default: throw new ExecutionError('infrastructure', `Unknown browser operation: ${String((operation as { kind?: unknown }).kind).slice(0, 40)}.`);
    }
  }
}

/** Every message crosses as JSON text, exactly as it would over a network. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** One check's browser session and the credential session it shares with its page (the thin CLI). */
export interface CheckSession { session: BrowserSession; credentials?: CredentialSession }

/**
 * Hosted runs: the browser side in this process, one host per page, sharing one OperatorState per agent, with every
 * request, response and event serialized.
 */
export function inProcessOperators(options: OperatorOptions): (page: Page) => OperatorTransport {
  const state = new OperatorState();
  return page => serialized(emit => new OperatorHost(state, options, emit, { page }));
}

/** Hosted runs: a check's whole browser session in this process, every message serialized. One environment
 * configures both the session and its page, so their policy, secrets and credentials cannot differ. */
export function inProcessSession(env: Omit<SessionEnvironment, 'onDenied' | 'onFailure'> & Pick<OperatorOptions, 'logger' | 'assertions'>): OperatorTransport {
  const options: OperatorOptions = { targetPolicy: env.policy, secrets: env.secrets, credentials: env.credentials, logger: env.logger, signal: env.signal, assertions: env.assertions };
  return serialized(emit => new OperatorHost(new OperatorState(), options, emit, { session: new BrowserSession({ ...env,
    onDenied: message => emit({ type: 'denied', message }), onFailure: message => emit({ type: 'failure', message }) }) }));
}

function serialized(create: (emit: (event: OperatorEvent) => void) => OperatorHost): OperatorTransport {
  const listeners: Array<(event: OperatorEvent) => void> = [];
  const host = create(event => {
    const delivered = wire(event);
    for (const listener of listeners) listener(delivered);
  });
  return {
    call: async request => wire(await host.handle(wire(request))),
    onEvent: listener => { listeners.push(listener); },
  };
}
