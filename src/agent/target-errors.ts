import { ExecutionError } from '../engine/execution-error.js';

/** A changed or missing target may be re-grounded for an action only before
 * dispatch. Post-dispatch continuity checks can observe outcomes, never replay. */
export class TargetChangedError extends ExecutionError {
  constructor(message: string, options?: ErrorOptions) { super('interaction', message, options); this.name = 'TargetChangedError'; }
}
/** A model selector overmatched before dispatch; fresh grounding may narrow it.
 * This is distinct from an authored instruction that genuinely has two matches. */
export class SelectorOvermatchError extends TargetChangedError {
  constructor(selector: string) { super(`Ambiguous target: ${selector} matches multiple visible elements. Observe again and identify one control.`); this.name = 'SelectorOvermatchError'; }
}
/** A completed native DOM read positively observed disconnection. This never
 * represents a failed query, destroyed context or unavailable observation. */
export class NativeTargetDetachedError extends TargetChangedError {
  constructor() { super('Target detached before identity inspection.'); this.name = 'NativeTargetDetachedError'; }
}
export class DisabledTargetError extends ExecutionError {
  constructor(message: string, options?: ErrorOptions) { super('interaction', message, options); this.name = 'DisabledTargetError'; }
}

/** The chosen element disagrees with authored identity; distinct from a non-unique instruction. */
export class SelectedTargetMismatchError extends ExecutionError {
  constructor(message: string) { super('configuration', message); this.name = 'SelectedTargetMismatchError'; }
}
