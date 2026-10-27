import { outsideQuotedText, scanQuotedText } from '../../shared/quoted-text.js';
import { KEYWORD_MAP, type Step } from './types.js';

/**
 * Parse a single step line (from a YAML `steps:` list) into a Step.
 *
 * Rules:
 *   - Match whole keywords, without requiring case or exact authoring aliases.
 *   - No match → `act` step (full line sent to the AI agent at run time).
 *   - YAML has already parsed comments. Every character in this string is data.
 */
export function parseStep(line: string, lineNumber: number): Step {
  const effectiveLine = line.trim();
  const unquoted = outsideQuotedText(effectiveLine);
  if (/\b(?:then|and(?: then)?)\s+(?:click|press|type|enter|submit|select|open|navigate|go|verify|check that|ensure|confirm)\b/i.test(unquoted)) return { keyword: 'act', argument: effectiveLine, lineNumber, raw: line };
  const strictPress = parseStrictPress(effectiveLine);
  if (strictPress) {
    return {
      keyword: 'press',
      argument: strictPress,
      lineNumber,
      raw: line,
    };
  }

  const assertion = effectiveLine.match(/^(?:Check that|Verify that|Ensure(?: that)?|Confirm that)\s+(.+)$/is);
  if (assertion) {
    return { keyword: 'verify', argument: assertion[1], lineNumber, raw: line };
  }

  // Only an explicit address establishes navigation; "Open the menu" remains an action.
  const navigation = effectiveLine.match(/^(?:Go to|Open)\s+(\{\{\s*app_url\s*\}\}|"[^"\s]+"|'[^'\s]+'|\S+)$/i);
  if (navigation) {
    const address = navigation[1].replace(/^(["'])(.*)\1$/, '$2');
    if (/^(?:https?:\/\/|\.{0,2}\/|#|\{\{\s*app_url\s*\}\})/i.test(address)) return { keyword: 'navigate_to', argument: address, lineNumber, raw: line };
  }
  const typed = /^Type\s+/i.exec(effectiveLine);
  if (typed) {
    const argument = effectiveLine.slice(typed[0].length);
    const separators = [...outsideQuotedText(argument).matchAll(/(?<=\s)(?:into|in)(?=\s)/gi)];
    if (separators.length === 1) {
      const separator = separators[0];
      const value = argument.slice(0, separator.index).trim();
      const target = argument.slice(separator.index! + separator[0].length).trim();
      const quoted = scanQuotedText(value).spans[0];
      const singleValue = quoted?.start === 0 ? quoted.closed && quoted.end === value.length : !/\b(?:and|then)\b/i.test(value);
      if (value && target && singleValue) return { keyword: 'enter', argument, lineNumber, raw: line };
    }
  }

  const lower = effectiveLine.toLowerCase();
  for (const [pattern, keyword] of KEYWORD_MAP) {
    if (lower === pattern.toLowerCase() || (lower.startsWith(pattern.toLowerCase()) && /\s/.test(effectiveLine[pattern.length] ?? ''))) {
      return {
        keyword,
        argument: effectiveLine.slice(pattern.length).trim(),
        lineNumber,
        raw: line,
      };
    }
  }

  // Catch-all — AI interprets the full line at run time.
  return {
    keyword: 'act',
    argument: effectiveLine,
    lineNumber,
    raw: line,
  };
}

function parseStrictPress(line: string): string | null {
  if (!/^Press\s+/i.test(line)) return null;
  const argument = line.replace(/^Press\s+/i, '');
  const spans = scanQuotedText(argument).spans;
  return spans.length === 2 && spans.every(span => span.closed) && spans[0].start === 0
    && /^\s+(?:on|in)\s+$/i.test(argument.slice(spans[0].end, spans[1].start))
    && !argument.slice(spans[1].end).trim() ? argument : null;
}
