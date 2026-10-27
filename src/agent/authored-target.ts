import { outsideQuotedText, quotedValue, scanQuotedText } from '../../shared/quoted-text.js';
import type { Step } from '../parser/types.js';
import type { TargetIdentity } from './target-identity.js';

/** Steps whose resolved targets can become reusable hints. */
export const CACHEABLE = new Set(['click', 'enter', 'select', 'hover_over', 'scroll_to']);

const literal = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const controlKinds = 'button|link|control|field|input|box|dropdown|option|radio|checkbox';
function ordinalParts(text: string): { prefix: string; rest: string } | undefined {
  const value = text.trim().replace(/^on\s+/i, '').replace(/^(?:the|a|an)\s+/i, '');
  const cardinal = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|and';
  const ordinal = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth|thousandth|millionth';
  const match = value.match(new RegExp(`^((?:\\d+(?:st|nd|rd|th)|(?:(?:${cardinal})[-\\s]+)*(?:${ordinal})))\\s+(.+)$`, 'i'));
  return match ? {prefix:match[1],rest:match[2]} : undefined;
}
export const hasAuthoredOrdinal = (text: string): boolean => Boolean(ordinalParts(text));
export const withoutAuthoredOrdinal = (text: string): string => ordinalParts(text)?.rest ?? text;
/** Ordinals constrain the document's matching controls, never the model selector. */
export function authoredOrdinal(text: string): number | undefined {
  const prefix = ordinalParts(text)?.prefix ?? '';
  const numeric = prefix.match(/^(\d+)(?:st|nd|rd|th)$/i);
  if (numeric) { const value = Number(numeric[1]); return Number.isSafeInteger(value) && value > 0 ? value : undefined; }
  const ordinals = ['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth','eleventh','twelfth','thirteenth','fourteenth','fifteenth','sixteenth','seventeenth','eighteenth','nineteenth'];
  const tens = ['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  const ordinalTens = ['twentieth','thirtieth','fortieth','fiftieth','sixtieth','seventieth','eightieth','ninetieth'];
  const value = prefix.toLowerCase();
  if (ordinals.includes(value)) return ordinals.indexOf(value) + 1;
  if (ordinalTens.includes(value)) return (ordinalTens.indexOf(value) + 2) * 10;
  const compound = value.split(/[-\s]+/);
  if (compound.length === 2 && tens.includes(compound[0]) && ordinals.indexOf(compound[1]) >= 0 && ordinals.indexOf(compound[1]) < 9) return (tens.indexOf(compound[0]) + 2) * 10 + ordinals.indexOf(compound[1]) + 1;
  return undefined;
}
export function explicitRoleTarget(text: string): { role: string; name: string } | undefined {
  const match = text.trim().match(/^role=(\w+)\[name=(.+)\]$/);
  if (!match) return undefined;
  const spans = scanQuotedText(match[2]).spans;
  if (spans.length !== 1 || spans[0].start !== 0 || spans[0].end !== match[2].length) return undefined;
  const name = quotedValue(spans[0]);
  return name === undefined ? undefined : { role: match[1].toLowerCase(), name };
}
export function literalTargetName(text: string): string | undefined {
  const explicit = explicitRoleTarget(text);
  if (explicit) return literal(explicit.name);
  const spans = scanQuotedText(text).spans;
  if (spans.length !== 1 || !spans[0].closed) return undefined;
  const span = spans[0];
  const before = authoredOrdinal(text) ? '' : text.slice(0, span.start).trim().replace(/^on\s+/i, '');
  const after = text.slice(span.end).trim().replace(/\.$/, '').trim();
  if (!new RegExp(`^(?:(?:the|a|an)(?:\\s+|$))?(?:(?:${controlKinds})\\s*)?$`, 'i').test(before)
    || !new RegExp(`^(?:${controlKinds})?$`, 'i').test(after)) return undefined;
  const value = quotedValue(span);
  return value === undefined ? undefined : literal(value);
}
export function targetRolesMatch(expected: string | undefined, target: TargetIdentity, clickFamily = false): boolean {
  const clickable = ['button','link'].includes(target.role) || target.interactive === true && !target.textEntry && !['checkbox','radio','switch','tab','menuitemcheckbox','menuitemradio','option','combobox','textbox','searchbox','spinbutton'].includes(target.role);
  return !expected || expected === target.role || clickFamily && ['button','link'].includes(expected) && clickable || expected === 'textbox' && (['searchbox', 'spinbutton'].includes(target.role) || target.role === 'combobox' && target.textEntry === true);
}
export function normalizeTargetName(text: string): string {
  const quoted = literalTargetName(text);
  if (quoted !== undefined) return quoted;
  return literal(text.trim().replace(/^(?:the|a|an)\s+/i, '').replace(/^(?:button|link|control|field|input|dropdown|option)\s+/i, '').replace(/\s+(?:button|link|control|field|input|dropdown|option)$/i, ''));
}
export function targetInstruction(step: Step): string {
  if (!['enter', 'select', 'press'].includes(step.keyword)) return step.argument.trim().replace(/\.$/, '').replace(/^on\s+(?=(?:the|a|an)\s+|["'])/i, '');
  const span = scanQuotedText(step.argument).spans[0];
  const separators = step.keyword === 'press' ? /^(?:on|in)\s+/i : /^(?:in|into|from)\s+/i;
  if (span?.start === 0 && span.closed) return step.argument.slice(span.end).trim().replace(separators, '').replace(/\.$/, '');
  return step.argument.replace(/^.+?\s+(?:in|into|from)\s+/i, '');
}
/** Only split qualifiers outside quoted names: "Sign up for free" is one control. */
export function authoredQualifier(step: Step): { control: string; entity: string; rawControl: string; relation: string } | undefined {
  const instruction = targetInstruction(step);
  const outside = outsideQuotedText(instruction);
  const match = /\b(for|within|in|on|next to|beside|under)\b(?=\s)/i.exec(outside);
  if (match) {
    const rawControl = instruction.slice(0, match.index).trim();
    const entity = instruction.slice(match.index + match[0].length).trim();
    if (!rawControl || /^(?:on|in)\s+(?:the\s+)?[^"']+\s+page$/i.test(instruction.slice(match.index))) return undefined;
    return { rawControl, control: normalizeTargetName(rawControl), entity: normalizeTargetName(entity.replace(/\s+(?:row|record|form|region)$/i, '')), relation: match[1].toLowerCase() };
  }
  return undefined;
}
/** A literal anchor can constrain an otherwise descriptive target, not prove its context. */
export function anchoredDescriptionTarget(step: Step, observedName?: string): { name: string; role?: string } | undefined {
  if (step.keyword !== 'click') return undefined;
  const instruction = targetInstruction(step);
  if (literalTargetName(instruction) !== undefined || authoredQualifier(step)) return undefined;
  if (observedName !== undefined && [literal(instruction), normalizeTargetName(instruction)].includes(literal(observedName))) return undefined;
  const spans = scanQuotedText(instruction).spans;
  if (spans.length !== 1 || !spans[0].closed || !instruction.slice(spans[0].end).trim()) return undefined;
  const prefix = instruction.slice(0, spans[0].end);
  const name = literalTargetName(prefix);
  if (!name) return undefined;
  const role = outsideQuotedText(prefix).match(/\b(button|link|field|input|dropdown|option|radio|checkbox)\b/i)?.[1].toLowerCase();
  return { name, ...(role ? { role } : {}) };
}
/** A qualified radio can be identified by its role and entity without inventing a name. */
export function qualifiedRoleOnly(qualifier: ReturnType<typeof authoredQualifier>): 'radio' | undefined {
  return qualifier?.entity && /^(?:(?:the|a|an)\s+)?radio(?:\s+button)?$/i.test(qualifier.rawControl.trim()) ? 'radio' : undefined;
}
export function qualifiedTargetBinding(step: Step, target: TargetIdentity, selector: string): boolean | undefined {
  if (hasAuthoredOrdinal(targetInstruction(step))) return undefined;
  if (anchoredDescriptionTarget(step, target.name)) return undefined;
  if (target.binding) {
    const qualifier = authoredQualifier(step);
    return target.binding.control === literalTargetName(targetInstruction(step)) || target.binding.control === literal(targetInstruction(step)) || target.binding.control === normalizeTargetName(targetInstruction(step)) || Boolean(qualifier && target.binding.control === (qualifiedRoleOnly(qualifier) ?? qualifier.control) && target.binding.entity === qualifier.entity && target.binding.relation === qualifier.relation);
  }
  // A word in the control's complete name is not authored role syntax.
  if (literal(targetInstruction(step)) === literal(target.name)) return true;
  const unquoted = outsideQuotedText(authoredQualifier(step)?.rawControl ?? targetInstruction(step));
  const role = unquoted.match(/\b(button|link|field|input|dropdown|radio|checkbox)\b/i)?.[1].toLowerCase();
  const expectedRole = role === 'field' || role === 'input' ? 'textbox' : role === 'dropdown' ? 'combobox' : role;
  if (!targetRolesMatch(expectedRole, target, step.keyword === 'click' && !explicitRoleTarget(targetInstruction(step)))) return false;
  const name = literal(target.name);
  const alias = /^(?:label|placeholder|text)=/.test(selector) ? literal(selector.slice(selector.indexOf('=') + 1)) : '';
  // Full names take precedence over English prepositions within those names.
  if ([name, alias].filter(Boolean).includes(normalizeTargetName(targetInstruction(step)))) return true;
  const qualified = authoredQualifier(step);
  if (!qualified) return literalTargetName(targetInstruction(step)) !== undefined ? false : undefined;
  const scope = (target.regionLabel || target.context || target.entity?.replace(/^[^:]+:/, '') || '').trim().toLowerCase();
  return Boolean(qualified.entity && qualified.entity === scope && [name, alias].includes(qualified.control));
}
export function authoredTargetMatches(step: Step, target: TargetIdentity, selector: string): boolean {
  const binding = qualifiedTargetBinding(step, target, selector);
  return binding === true;
}

export function authoredEntity(step: Step, target: TargetIdentity, selector: string): string | undefined {
  if (literal(targetInstruction(step)) === literal(target.name)) return undefined;
  const alias = /^(?:label|placeholder|text)=/.test(selector) ? literal(selector.slice(selector.indexOf('=') + 1)) : '';
  if (target.binding) return target.binding.entity;
  if ([literal(target.name), alias].filter(Boolean).includes(normalizeTargetName(targetInstruction(step)))) return undefined;
  return qualifiedTargetBinding(step, target, selector) === true ? authoredQualifier(step)?.entity : undefined;
}
