import { readDOM } from './dom-reader.js';
import { NativeTargetDetachedError } from './target-errors.js';
import type { ElementHandle } from 'playwright';
import { redactText } from '../security/redaction.js';
/** Browser-observed meaning of a target, independent of its selector or CSS position. */
export interface TargetIdentity {
  role: string; name: string; inputType: string; href: string; context: string;
  /** Stable row/record meaning, not its position in a list. */
  entity?: string;
  /** Closest labelled container, used only to bind explicitly authored qualifiers. */
  regionLabel?: string;
  /** Form/fieldset ownership distinguishes otherwise identical controls. */
  form?: string;
  /** Owning document plus the embedding frame's declared identity. */
  frame?: string;
  /** Versioned independent authored-intent proof; historical hints must re-ground. */
  binding?: { version: 1 | 2; control: string; entity?: string; relation?: string };
  interactive?: boolean;
  textEntry?: boolean;
}
export async function readTargetIdentity(handle: ElementHandle<SVGElement | HTMLElement>, secrets: readonly string[] = [], nameLimit = 500): Promise<TargetIdentity> {
  const identity = await readDOM(handle, 'identity');
  if (identity === null) throw new NativeTargetDetachedError();
  // Configured secrets never enter target-frame JavaScript. Redact complete raw
  // fields in the controller before whitespace normalization or truncation.
  const normalize = (value: string, limit = 500) => redactText(value, secrets).replace(/\s+/g, ' ').trim().slice(0, limit);
  const { roleFromTag, scriptHandlerCandidate, formParts, frameParts, ...raw } = identity;
  // DOM0 callback state belongs to the application's world, unlike DOM facts.
  // Preserve the existing focusable custom-control compatibility hint only;
  // it never supplies a name, role, entity, credential or policy permission.
  if (!raw.interactive && scriptHandlerCandidate) raw.interactive = await handle.evaluate(element => typeof (element as any).onclick === 'function');
  const normalized: TargetIdentity = { ...raw, role: normalize(raw.role), name: normalize(raw.name, nameLimit),
    inputType: normalize(raw.inputType).toLowerCase(), href: normalize(raw.href), context: normalize(raw.context),
    ...(raw.regionLabel ? { regionLabel: normalize(raw.regionLabel) } : {}),
    ...(raw.entity ? { entity: normalize(raw.entity, 1000) } : {}) };
  if (roleFromTag) normalized.role = normalized.role.toLowerCase();
  if (formParts.length) {
    const parts = formParts.map((part: string) => normalize(part));
    parts[2] = parts[2].toLowerCase();
    normalized.form = JSON.stringify(parts);
  }
  if (frameParts.length) normalized.frame = JSON.stringify(frameParts.map((part: string) => redactText(part, secrets)));
  return normalized;
}
export function sameTargetIdentity(a: TargetIdentity, b: TargetIdentity): boolean {
  return compareTargetIdentity(a, b).equivalent;
}

/** Selector/layout changes are allowed; a missing or changed semantic binding is not. */
export function compareTargetIdentity(previous: TargetIdentity, current: TargetIdentity): { equivalent: boolean; reason: string } {
  for (const field of ['role', 'name', 'inputType', 'href', 'entity', 'form', 'frame'] as const) {
    if ((previous[field] ?? '') !== (current[field] ?? '')) return { equivalent: false, reason: `Recovered target has different ${field} meaning.` };
  }
  if (previous.binding && JSON.stringify(previous.binding) !== JSON.stringify(current.binding)) return { equivalent: false, reason: 'Recovered target has different authored binding.' };
  if (previous.context !== current.context) return { equivalent: false, reason: 'Recovered target has different context meaning.' };
  if (previous.regionLabel !== undefined && previous.regionLabel !== current.regionLabel) return { equivalent: false, reason: 'Recovered target has different region meaning.' };
  return { equivalent: true, reason: 'The target retains its control, entity, form and frame meaning.' };
}
