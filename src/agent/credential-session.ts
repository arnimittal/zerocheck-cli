import { isTransientObservationError } from './observation-recovery.js';
import { readDOM, readDOMSnapshot, sameDOMNode, selectDOM } from './dom-reader.js';
import { ExecutionError } from '../engine/execution-error.js';
import { parseWaitDescription } from '../../shared/outcomes.js';
import { randomUUID } from 'node:crypto';
import type { ElementHandle, Frame } from 'playwright';
import type { Step } from '../parser/types.js';
import { KEYWORD_MAP } from '../parser/types.js';
import type { ActionPlan } from './types.js';
import type { TargetPolicy } from '../policy/target-policy.js';
import type { ExecutionConfig } from '../../shared/contracts.js';
import { frameOrigin } from './frame-policy.js';
import { containsConfiguredSecret, assertSecretNavigationAllowed } from './credential-boundary.js';
import { parseVisibleTextAssertion, type VisibleTextAssertion } from './text-assertions.js';
import { literalValue } from './literal-value.js';
import { redactionValues } from '../security/redaction.js';

const REFERENCE = /\$\{([^}]+)\}|\{\{\s*credential:([A-Za-z0-9_.:-]+)\s*\}\}/g;
const TOKEN = /ZCBOUND_[a-f0-9]{32}_\d+_END/g;
export interface Binding { token: string; name: string; reference: string }
/** Which configured secret each token in one prepared step stands for: never a value. The instance sends these to the
 * thin CLI, which holds the values. */
export interface StepBindings { key: string; bindings: Binding[] }
interface Prepared { bindings: Binding[]; display?: Step }
interface BoundControl { frame: Frame; control: ElementHandle<any>; form?: ElementHandle<any>; names: string[] }
export interface CredentialAction { plan: ActionPlan; names: string[] }

/** Runner-owned state. Neither step text nor model output can set its phase or create grants. */
export class CredentialSession {
  private phase: 'setup' | 'login' | 'body' = 'setup';
  /** Keyed by content, not object identity, so a step keeps its bindings after crossing the operator boundary as
   * plain data. A step with bindings carries their random tokens in its text, so no other step has its key. */
  private readonly prepared = new Map<string, Prepared>();
  private readonly controls: BoundControl[] = [];
  private readonly grants: Map<string, Set<string>>;
  constructor(private readonly secrets: Record<string, string>, grants: Record<string, string[]>, private readonly policy: TargetPolicy,
    /** The instance of a thin CLI run: it prepares and displays steps by secret name, and holds no values. */
    private readonly valueless = false) {
    this.grants = new Map(Object.entries(grants).map(([name, origins]) => [name, new Set(origins.map(origin => new URL(origin).origin))]));
  }

  /** Steps prepared by name only; anything that would need a value refuses. */
  static withoutValues(names: readonly string[], policy: TargetPolicy): CredentialSession {
    return new CredentialSession(Object.fromEntries(names.map(name => [name, ''])), {}, policy, true);
  }
  private requireValues(): void {
    if (this.valueless) throw new ExecutionError('configuration', 'This side holds no secret values; the machine that runs the browser fills credentials.');
  }

  /** The binding table for the thin CLI: the tokens of every prepared step that has credentials, with their names. */
  exportBindings(): StepBindings[] {
    return [...this.prepared].filter(([, prepared]) => prepared.bindings.length).map(([key, prepared]) => ({ key, bindings: prepared.bindings.map(binding => ({ ...binding })) }));
  }

  /** The thin CLI takes the instance's binding table. A token names a secret; only this machine's value fills it, and
   * every destination check still applies here. A secret this machine does not hold fails the run before it starts.
   * The instance is the customer's own and is trusted to say which configured secret a step uses, and which phase a
   * step is in; this machine still decides where a value may go: the app's origin, or, in login steps, an origin this
   * machine's zerocheck.yaml grants to that secret. */
  importBindings(entries: unknown): void {
    if (!Array.isArray(entries)) throw new ExecutionError('configuration', 'The credential bindings could not be read.');
    for (const entry of entries as StepBindings[]) {
      if (!entry || typeof entry.key !== 'string' || !Array.isArray(entry.bindings)) throw new ExecutionError('configuration', 'The credential bindings could not be read.');
      for (const binding of entry.bindings) {
        if (!binding || typeof binding.token !== 'string' || !/^ZCBOUND_[a-f0-9]{32}_\d+_END$/.test(binding.token) || typeof binding.reference !== 'string' || typeof binding.name !== 'string') {
          throw new ExecutionError('configuration', 'The credential bindings could not be read.');
        }
        if (!Object.prototype.hasOwnProperty.call(this.secrets, binding.name) || !this.secrets[binding.name]) throw new ExecutionError('configuration', `This run needs the secret '${binding.name}', which is not set on this machine.`);
      }
      this.prepared.set(entry.key, { bindings: entry.bindings.map(({ token, name, reference }) => ({ token, name, reference })) });
    }
  }

  beginPhase(phase: 'setup' | 'login' | 'body'): void { this.phase = phase; }

  /** Only executable, already-parsed arguments provide bindings; comments never do. */
  prepare(authored: Step, expandPublic: (value: string) => string = value => value): Step {
    const bindings: Binding[] = [];
    const nonce = randomUUID().replaceAll('-', '');
    const argument = expandPublic(authored.argument.replace(REFERENCE, (reference, first: string | undefined, second: string | undefined) => {
      const name = first ?? second!;
      if (!Object.prototype.hasOwnProperty.call(this.secrets, name) || !this.valueless && !this.secrets[name]) throw new ExecutionError('configuration', `Missing secret '${name}' in the selected environment configuration.`);
      const token = `ZCBOUND_${nonce}_${bindings.length}_END`;
      bindings.push({ token, name, reference }); return token;
    }));
    const prefix = authored.keyword === 'act' ? '' : authored.keyword === 'press' ? 'Press ' : `${KEYWORD_MAP.find(([, keyword]) => keyword === authored.keyword)![0]} `;
    const step = { ...authored, argument, raw: `${prefix}${argument}` };
    if (bindings.length) {
      const value = literalValue(step);
      const assertion = ['verify', 'wait_for'].includes(step.keyword) ? parseVisibleTextAssertion(step.keyword === 'wait_for' ? parseWaitDescription(step.argument).cleanDescription : step.argument, step.keyword === 'wait_for') : null;
      if (step.keyword !== 'act' && !bindings.every(binding => (value ?? assertion?.text ?? '').includes(binding.token))) {
        throw new ExecutionError('configuration', 'Invalid configuration: credential references are supported in Enter/Select values, quoted-text expectations, and act instructions only. Navigation URLs and target descriptions cannot contain credentials.');
      }
    }
    const restore = (value: string) => bindings.reduce((text, binding) => text.split(binding.token).join(binding.reference), value);
    this.prepared.set(stepKey(step), { bindings, display: { ...step, argument: restore(argument), raw: restore(step.raw) } });
    return step;
  }

  display(step: Step): Step { return this.prepared.get(stepKey(step))?.display ?? step; }
  displayText(step: Step, text: string): string {
    return (this.prepared.get(stepKey(step))?.bindings ?? []).reduce((out, binding) => out.split(binding.token).join(binding.reference), text);
  }
  literalAssertion(step: Step, argument = step.argument): VisibleTextAssertion | null {
    this.requireValues();
    const parsed = parseVisibleTextAssertion(step.keyword === 'wait_for' ? parseWaitDescription(argument).cleanDescription : argument, step.keyword === 'wait_for');
    if (!parsed) return null;
    const resolved = this.resolve(step, parsed.text);
    // Even explicit phrase wording cannot broaden a configured credential comparison.
    if (resolved.names.length) { const { match: _match, ...exact } = parsed; return { ...exact, text: resolved.value }; }
    return { ...parsed, text: resolved.value };
  }

  /** This is called only after the controller has resolved the target and completed preflight. */
  materialize(step: Step, plan: ActionPlan): CredentialAction {
    this.requireValues();
    this.assertStructure(step, plan);
    if (!['fill', 'select'].includes(plan.action)) return { plan, names: [] };
    const value = this.resolve(step, plan.value ?? '');
    return { plan: { ...plan, value: value.value }, names: value.names };
  }

  assertStructure(step: Step, plan: ActionPlan): void {
    this.requireValues();
    const containsReference = (text: string) => /ZCBOUND_|\$\{|\{\{\s*credential:/.test(text);
    if ([plan.selector, plan.fallback_selector ?? '', ...(plan.framePath ?? [])].some(containsReference)) throw new ExecutionError('policy', 'TargetPolicy blocked credential references in a target description.');
    if (plan.action === 'navigate') {
      if (containsReference(plan.value ?? '')) throw new ExecutionError('policy', 'TargetPolicy blocked credentials in a navigation URL.');
      assertSecretNavigationAllowed(plan.value || plan.selector, this.policy, Object.values(this.secrets));
    } else if (!['fill', 'select'].includes(plan.action) && containsReference(plan.value ?? '')) {
      throw new ExecutionError('policy', 'TargetPolicy permits credential values only in literal fill or select actions.');
    }
    // Verify token provenance before grounding; values remain opaque until dispatch.
    if (['fill', 'select'].includes(plan.action)) this.bindingsFor(step, plan.value ?? '');
  }

  private bindingsFor(step: Step, template: string): Binding[] {
    const known = this.prepared.get(stepKey(step))?.bindings ?? [];
    const tokens = template.match(TOKEN) ?? [];
    const used = tokens.map(token => {
      const binding = known.find(item => item.token === token);
      if (!binding) throw new ExecutionError('policy', 'TargetPolicy blocked a credential binding not present in the authored instruction.');
      return binding;
    });
    const literal = template.replace(TOKEN, '');
    if (/ZCBOUND_|\$\{|\{\{\s*credential:/.test(literal)) throw new ExecutionError('policy', 'TargetPolicy blocked an unbound credential reference.');
    if (containsConfiguredSecret(literal, Object.values(this.secrets))) throw new ExecutionError('policy', 'TargetPolicy blocked a literal credential value without an authored binding.');
    return used;
  }
  private resolve(step: Step, template: string): { value: string; names: string[] } {
    const bindings = this.bindingsFor(step, template);
    // One replacement pass: quotes, newlines and placeholder-like password text remain literal data.
    const value = template.replace(TOKEN, token => this.secrets[bindings.find(binding => binding.token === token)!.name]);
    const names = new Set(bindings.map(binding => binding.name));
    // Aliases and overlapping configured values require the intersection of all permissions.
    for (const [name, secret] of Object.entries(this.secrets)) if (secret && containsConfiguredSecret(value, [secret])) names.add(name);
    return { value, names: [...names] };
  }
  private assertNames(names: readonly string[], origin: string): void {
    for (const name of names) if (origin !== this.policy.appOrigin && (this.phase !== 'login' || !this.grants.get(name)?.has(origin))) {
      throw new ExecutionError('policy', `TargetPolicy blocked credential '${name}' on ${origin}. Additional secret_origins grants apply only during configured login steps.`);
    }
  }

  async authorize(handle: ElementHandle<any>, action: CredentialAction): Promise<void> {
    this.requireValues();
    const frame = await handle.ownerFrame();
    if (!frame) throw new ExecutionError('policy', 'TargetPolicy cannot establish the credential destination.');
    const origins: string[] = [];
    for (let ancestor: Frame | null = frame; ancestor; ancestor = ancestor.parentFrame()) origins.push(await frameOrigin(ancestor));
    // Refuse named credential operations before reading any control values.
    for (const origin of origins) this.assertNames(action.names, origin);
    const related: BoundControl[] = [];
    for (let index = this.controls.length - 1; index >= 0; index--) {
      const item = this.controls[index];
      const alive = !item.frame.isDetached() && await boundControlAlive(item.control, handle);
      const liveForm = !item.frame.isDetached() && item.form && await boundControlAlive(item.form, handle);
      if (!alive && !liveForm) { this.controls.splice(index, 1); continue; }
      if (item.frame === frame) related.push(item);
    }
    const snapshot = await readDOMSnapshot(handle, 'credentialForm');
    const inspected = snapshot.facts;
    const knownNames = new Set<string>(), unknownNames = new Set<string>();
    try {
      const form = inspected.hasForm ? snapshot.nodes[snapshot.nodes.length - 1] : undefined;
      if (form) for (const binding of related) if (binding.form && await sameDOMNode(form, binding.form)) for (const name of binding.names) knownNames.add(name);
      for (let index = 0; index < inspected.values.length; index++) {
        const control = snapshot.nodes[index], value = inspected.values[index];
        for (const [name, secret] of Object.entries(this.secrets)) {
          if (!redactionValues([secret]).some(candidate => value.includes(candidate))) continue;
          let known = false;
          for (const binding of related) if (binding.names.includes(name) && await sameDOMNode(control, binding.control)) { known = true; break; }
          (known ? knownNames : unknownNames).add(name);
        }
      }
    } finally { await Promise.all(snapshot.nodes.map(node => node.dispose())); }
    const names = [...new Set([...action.names, ...knownNames, ...unknownNames])];
    for (const destination of inspected.destinations) {
      this.policy.assertCurrentUrl(destination);
      assertSecretNavigationAllowed(destination, this.policy, Object.values(this.secrets));
      origins.push(new URL(destination).origin);
    }
    if (unknownNames.size && origins.some(origin => origin !== this.policy.appOrigin)) throw new ExecutionError('policy', 'TargetPolicy blocked existing credential data without a trusted input binding. Start from a clean login form.');
    for (const origin of origins) this.assertNames(names, origin);
  }

  async bindInput(handle: ElementHandle<any>, action: CredentialAction): Promise<void> {
    this.requireValues();
    if (!action.names.length || !['fill', 'select'].includes(action.plan.action)) return;
    const frame = await handle.ownerFrame();
    if (!frame) throw new ExecutionError('policy', 'TargetPolicy cannot bind the credential input to its frame.');
    const formHandle = await selectDOM(handle, 'form');
    const form = formHandle ?? undefined;
    this.controls.push({ frame, control: handle, form, names: action.names });
  }

  /** Native main-document submissions remain subject to the current phase on each redirect hop. */
  assertNavigation(url: string, postData?: string): void {
    this.requireValues();
    assertSecretNavigationAllowed(url, this.policy, Object.values(this.secrets));
    if (postData) this.assertNames(Object.entries(this.secrets).filter(([, value]) => value && containsConfiguredSecret(postData, [value])).map(([name]) => name), new URL(url).origin);
  }
}

/** A run's credential session: by name only for a run whose browser is on a thin CLI's machine, with values otherwise. */
export function credentialSessionFor(config: Pick<ExecutionConfig, 'secrets' | 'secretNames' | 'secretOrigins'>, policy: TargetPolicy): CredentialSession {
  return config.secretNames ? CredentialSession.withoutValues(config.secretNames, policy) : new CredentialSession(config.secrets ?? {}, config.secretOrigins ?? {}, policy);
}

const stepKey = (step: Step) => JSON.stringify([step.keyword, step.lineNumber, step.raw, step.argument]);

/** A destroyed native execution context proves an old binding is obsolete.
 * An unknown read in a live context must never discard credential provenance. */
async function boundControlAlive(previous: ElementHandle<any>, current: ElementHandle<any>): Promise<boolean> {
  try { await previous.ownerFrame(); await previous.evaluate(() => true); }
  catch (error) {
    if (!isTransientObservationError(error)) throw error;
    await current.evaluate(() => true);
    return false;
  }
  return readDOM(previous, 'connected');
}
