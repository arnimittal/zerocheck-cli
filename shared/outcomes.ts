import { scanQuotedText, quotedValue, outsideQuotedText } from './quoted-text.js';
/** Pure outcome grammar shared by authoring, validation and browser execution. */
export interface VisibleTextAssertion { text: string; visible: boolean; match?: 'phrase'; absence?: 'throughout'; windowMs?: number }
export interface OutcomeStep { keyword: string; argument: string }
export const DEFAULT_NEGATIVE_WINDOW_MS = 3_000;
export const NEGATIVE_OUTCOME_REMEDY = 'Negative checks need quoted text, e.g. Verify "Your card was declined" is not visible for 3 seconds. Use exact text for a whole-text comparison.';

export function parseTimedWaitMs(value: string | null | undefined): number | null {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)$/i);
  if (!match) return null;
  const amount = Number(match[1]) * (/^(?:ms|milli)/i.test(match[2]) ? 1 : /^(?:m|minute)/i.test(match[2]) ? 60_000 : 1000);
  return Number.isSafeInteger(amount) ? amount : null;
}
export function parseWaitDescription(description: string): { deadlineMs: number; cleanDescription: string } {
  const match = description.match(/\(\s*up to (\d+(?:\.\d+)?)\s*(s|seconds?)\s*\)\s*$/i);
  return match?.index === undefined ? { deadlineMs: 30_000, cleanDescription: description.trim() }
    : { deadlineMs: Number(match[1]) * 1000, cleanDescription: description.slice(0, match.index).trim() };
}

function quotedParts(value: string): Array<{ start: number; end: number; text: string }> {
  return scanQuotedText(value).spans.flatMap(span => {
    const text = quotedValue(span);
    return text === undefined ? [] : [{ start: span.start, end: span.end, text }];
  });
}

export function parseVisibleTextAssertion(argument: string, bareText = false): VisibleTextAssertion | null {
  const window = argument.match(/\s+(?:for|over)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)\s*[.!]?$/i);
  let body = (window ? argument.slice(0, window.index) : argument).trim();
  const mode = body.match(/^(phrase|(?:the\s+)?exact(?:\s+text)?)\s+/i)?.[1];
  if (mode) body = body.slice(mode.length).trim();
  const parts = quotedParts(body);
  if (parts.length !== 1) return null;
  const literal = parts[0];
  const predicate = `${body.slice(0, literal.start)}TEXT${body.slice(literal.end)}`.replace(/[.!]$/, '').replace(/[’‘]/g, "'").trim();
  const positive = /^(?:(?:the\s+)?(?:text\s+)?TEXT\s+(?:is\s+(?:visible|shown|displayed)|appears?)|(?:the\s+)?(?:page\s+)?(?:shows|contains|displays)\s+TEXT)$/i.test(predicate)
    || bareText && predicate === 'TEXT';
  const throughout = /^(?:the\s+)?(?:text\s+)?TEXT\s+(?:(?:does\s+not|doesn't)\s+appear|never\s+appears?)$/i.test(predicate);
  const negative = throughout || /^(?:(?:the\s+)?(?:text\s+)?TEXT\s+is\s+(?:not\s+(?:visible|shown|displayed)|hidden)|(?:the\s+)?page\s+(?:does\s+not|doesn't)\s+(?:show|contain|display)\s+TEXT|no\s+TEXT\s+is\s+(?:shown|visible|displayed))$/i.test(predicate);
  if (!positive && !negative) return null;
  if (positive && window) throw new Error('Invalid configuration: a positive text check cannot use an absence observation window. Use Wait for \"text\" is visible (up to N seconds) to set a wait deadline.');
  const phrase = mode?.toLowerCase() === 'phrase' || negative && !mode;
  if (phrase && !literal.text.trim()) throw new Error('Invalid configuration: phrase assertions need nonempty text.');
  const windowMs = window ? Number(window[1]) * (/^(ms|milli)/i.test(window[2]) ? 1 : /^(m|minute)/i.test(window[2]) ? 60_000 : 1000) : undefined;
  if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs < 1 || windowMs > 60_000)) throw new Error('Invalid configuration: text observation windows must be between 1ms and 60 seconds.');
  return { text: literal.text, visible: positive, ...(phrase ? { match: 'phrase' as const } : {}), ...(throughout ? { absence: 'throughout' as const } : {}), ...(windowMs !== undefined ? { windowMs } : {}) };
}

export function validateOutcomeStep(step: OutcomeStep): void {
  if (!['verify', 'wait_for'].includes(step.keyword)) return;
  const argument = step.keyword === 'wait_for' ? parseWaitDescription(step.argument).cleanDescription : step.argument;
  if (!argument.trim()) throw new Error('Invalid configuration: the step needs an expected outcome, e.g. Wait for "Ready" is visible.');
  if (step.keyword === 'wait_for') {
    const ms = parseTimedWaitMs(argument);
    if (ms !== null) { if (ms > 60_000) throw new Error('Invalid configuration: timed waits are limited to 60 seconds.'); return; }
    if (/^\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)\s*$/i.test(argument)) throw new Error('Invalid configuration: use a timed wait between 0 and 60 seconds, e.g. Wait for 0.5 seconds.');
  }
  if (parseVisibleTextAssertion(argument, step.keyword === 'wait_for')) return;
  // This existing typed URL predicate is an immediate URL-state comparison, not text absence.
  if (/^the URL does not have query param (?:"[^"]+"|\S+)\.?$/i.test(argument)) return;
  const outside = outsideQuotedText(argument);
  if (/\b(?:no|not|never|none|neither|zero|without|absent|hidden|invisible|cannot)\b|\b\w+n['’]t\b/i.test(outside)) {
    if (/\brequest\b/i.test(outside)) throw new Error('Invalid configuration: negative network assertions require a defined observation window and are not supported yet.');
    throw new Error(`Invalid configuration: ${NEGATIVE_OUTCOME_REMEDY}`);
  }
}

export function isOutcomeStep(step: OutcomeStep): boolean {
  return step.keyword === 'verify' || step.keyword === 'wait_for' && parseTimedWaitMs(parseWaitDescription(step.argument).cleanDescription) === null;
}
export function outcomeInstruction(raw: string): OutcomeStep | undefined {
  const match = raw.trim().match(/^(Verify(?: that)?|Check that|Ensure(?: that)?|Confirm that|Wait for)\s+(.+)$/is);
  return match ? { keyword: /^wait/i.test(match[1]) ? 'wait_for' : 'verify', argument: match[2] } : undefined;
}

/** New authoring makes implicit negative defaults reviewable; existing definitions are not rewritten. */
export function materializeOutcomeDefaults(raw: string): string {
  const step = outcomeInstruction(raw);
  if (!step) return raw;
  const body = step.keyword === 'wait_for' ? parseWaitDescription(step.argument).cleanDescription : step.argument;
  const suffix = step.keyword === 'wait_for' ? step.argument.slice(step.argument.indexOf(body) + body.length) : '';
  const assertion = parseVisibleTextAssertion(body);
  if (!assertion || assertion.visible) return raw;
  const credential = /\$\{|\{\{\s*credential:/.test(assertion.text);
  let argument = body;
  if (!/^(?:phrase|(?:the\s+)?exact(?:\s+text)?)\s+/i.test(argument)) argument = `${credential ? 'exact text' : 'phrase'} ${argument}`;
  if (step.keyword === 'verify' && assertion.windowMs === undefined) argument = `${argument.replace(/[.!]$/, '')} for ${DEFAULT_NEGATIVE_WINDOW_MS / 1000} seconds`;
  return `${step.keyword === 'verify' ? 'Verify' : 'Wait for'} ${argument}${suffix}`;
}

/** Reading an old definition must remain possible even when current validation rejects it. */
export function outcomePreview(raw: string): { outcome: boolean; detail?: string } {
  const step = outcomeInstruction(raw);
  if (!step) return { outcome: false };
  try {
    validateOutcomeStep(step);
    const argument = step.keyword === 'wait_for' ? parseWaitDescription(step.argument).cleanDescription : step.argument;
    const assertion = parseVisibleTextAssertion(argument, step.keyword === 'wait_for');
    if (assertion?.visible) {
      const credential = /\$\{|\{\{\s*credential:/.test(assertion.text);
      const detail = credential ? 'Matching: exact credential text.'
        : assertion.match === 'phrase' ? 'Matching: phrase within longer text, with word and identifier boundaries. Configured credentials remain exact.'
          : 'Matching: exact whole-element text. Use phrase only if text within a longer message is intended.';
      return { outcome: true, detail };
    }
    const effective = materializeOutcomeDefaults(raw);
    return { outcome: isOutcomeStep(step), ...(effective !== raw ? { detail: `Effective: ${effective}` } : {}) };
  } catch (error) {
    return { outcome: isOutcomeStep(step), detail: error instanceof Error ? error.message : 'This outcome needs correction before running.' };
  }
}
