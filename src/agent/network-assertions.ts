import { NetworkRecorder } from './network-recorder.js';

/**
 * Deterministic network assertions for the `Verify` keyword.
 *
 * Recognizes a handful of request-specific patterns in a Verify
 * argument and answers them by querying the per-page NetworkRecorder.
 * Unrecognized patterns return `{ matched: false }` so the caller
 * falls through to the AI-based assertion evaluator.
 *
 * Supported grammars (case-insensitive, quotes optional):
 *
 *   a request to "<url-substring>" was made
 *   a request for "<url-substring>" was made
 *   a <METHOD> request to "<url-substring>" was made
 *   a request to "<url-substring>" returned <status>
 *   a <METHOD> request to "<url-substring>" returned <status>
 *   no request to "<url-substring>" was made
 */

interface NetworkAssertionResult {
  matched: boolean;
  passed?: boolean;
  reason?: string;
}

const NOT_MATCHED: NetworkAssertionResult = { matched: false };

const TOKEN = /(?:"([^"]+)"|(\S+))/.source;
const METHOD = /(?:GET|POST|PUT|PATCH|DELETE|HEAD)/.source;

function firstCapture(match: RegExpMatchArray, startIndex: number): string {
  return match[startIndex] ?? match[startIndex + 1] ?? '';
}

export function evaluateNetworkAssertion(
  argument: string,
  recorder: NetworkRecorder | null,
): NetworkAssertionResult {
  const trimmed = argument.trim();

  // Fast reject: if the argument doesn't contain "request" at all, we
  // can't possibly match any network pattern. Avoids running every
  // regex on, e.g., `the page is loaded`.
  if (!/request/i.test(trimmed)) return NOT_MATCHED;
  if (/^no\s+(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+)?request\b/i.test(trimmed)) throw new Error('Invalid configuration: negative network assertions require a defined observation window and are not supported yet.');

  if (!recorder) {
    // The argument talks about a request but we have no recorder
    // attached — that's a runner wiring bug, but reporting it here
    // with a clear error beats silently falling through to the AI
    // evaluator (which can't see network state anyway).
    if (matchesAnyNetworkPattern(trimmed)) {
      return {
        matched: true,
        passed: false,
        reason: 'Network assertion used but no NetworkRecorder is attached to this page',
      };
    }
    return NOT_MATCHED;
  }

  // `a <METHOD> request to|for "<url>" returned <status>`
  const methodStatusRe = new RegExp(
    `^a (${METHOD}) request (?:to|for) ${TOKEN} returned (\\d{3})\\.?$`,
    'i',
  );
  const methodStatusMatch = trimmed.match(methodStatusRe);
  if (methodStatusMatch) {
    const method = methodStatusMatch[1].toUpperCase();
    const url = firstCapture(methodStatusMatch, 2);
    const status = parseInt(methodStatusMatch[4], 10);
    const hits = recorder.query({ method, urlContains: url, status });
    if (hits.length === 0) {
      return {
        matched: true,
        passed: false,
        reason: buildMissingReason(recorder, method, url, status),
      };
    }
    return { matched: true, passed: true };
  }

  // `a request to|for "<url>" returned <status>`
  const anyStatusRe = new RegExp(
    `^a request (?:to|for) ${TOKEN} returned (\\d{3})\\.?$`,
    'i',
  );
  const anyStatusMatch = trimmed.match(anyStatusRe);
  if (anyStatusMatch) {
    const url = firstCapture(anyStatusMatch, 1);
    const status = parseInt(anyStatusMatch[3], 10);
    const hits = recorder.query({ urlContains: url, status });
    if (hits.length === 0) {
      return {
        matched: true,
        passed: false,
        reason: buildMissingReason(recorder, undefined, url, status),
      };
    }
    return { matched: true, passed: true };
  }

  // `a <METHOD> request to|for "<url>" was made`
  const methodMadeRe = new RegExp(
    `^a (${METHOD}) request (?:to|for) ${TOKEN} was made\\.?$`,
    'i',
  );
  const methodMadeMatch = trimmed.match(methodMadeRe);
  if (methodMadeMatch) {
    const method = methodMadeMatch[1].toUpperCase();
    const url = firstCapture(methodMadeMatch, 2);
    const hits = recorder.query({ method, urlContains: url });
    if (hits.length === 0) {
      return {
        matched: true,
        passed: false,
        reason: buildMissingReason(recorder, method, url),
      };
    }
    return { matched: true, passed: true };
  }

  // `a request to|for "<url>" was made`
  const anyMadeRe = new RegExp(
    `^a request (?:to|for) ${TOKEN} was made\\.?$`,
    'i',
  );
  const anyMadeMatch = trimmed.match(anyMadeRe);
  if (anyMadeMatch) {
    const url = firstCapture(anyMadeMatch, 1);
    const hits = recorder.query({ urlContains: url });
    if (hits.length === 0) {
      return {
        matched: true,
        passed: false,
        reason: buildMissingReason(recorder, undefined, url),
      };
    }
    return { matched: true, passed: true };
  }

  return NOT_MATCHED;
}

/**
 * Cheap pre-filter — does the argument even look like one of the
 * supported grammars? Used to decide whether a missing recorder is
 * a runner bug vs. just an unrelated `Verify` argument that happens
 * to contain the word "request".
 */
function matchesAnyNetworkPattern(argument: string): boolean {
  return (
    /^a (?:GET|POST|PUT|PATCH|DELETE|HEAD)? ?request (?:to|for) /i.test(argument) ||
    /^no request (?:to|for) /i.test(argument)
  );
}

/**
 * Build a specific "not found" error message that includes a
 * sample of what WAS seen on the page, so authors can diagnose
 * typos and path mismatches without cracking open the browser.
 */
function buildMissingReason(
  recorder: NetworkRecorder,
  method: string | undefined,
  url: string,
  status?: number,
): string {
  const label = [
    method ?? 'any',
    `request to "${url}"`,
    status != null ? `with status ${status}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const recent = recorder
    .getAll()
    .slice(-5)
    .map((r) => `${r.method} ${r.url} → ${r.status}`);
  if (recent.length === 0) {
    return `Expected ${label}, but no requests were recorded on this page`;
  }
  return `Expected ${label}, none matched. Recent requests: ${recent.join(', ')}`;
}
