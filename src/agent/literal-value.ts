import type { Step } from '../parser/types.js';
import { scanQuotedText, quotedValue } from '../../shared/quoted-text.js';

/** Parse authored data before credentials are introduced, using the shared quote grammar. */
export function literalValue(step: Step): string | undefined {
  if (!['enter', 'select'].includes(step.keyword)) return undefined;
  const span = scanQuotedText(step.argument).spans[0];
  if (span?.start === 0) return /^\s+(?:in|into|from)\b/i.test(step.argument.slice(span.end)) ? quotedValue(span) : undefined;
  return step.argument.match(/^(.+?)\s+(?:in|into|from)\s+.+$/is)?.[1].trim();
}
