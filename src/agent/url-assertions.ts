/**
 * Deterministic URL assertions for the `Verify` keyword.
 *
 * Recognizes a handful of URL-specific patterns inside a Verify
 * argument and evaluates them directly against `page.url()` — no AI
 * call needed. Unrecognized patterns return `{ matched: false }` so
 * the caller can fall through to the AI-based assertion evaluator.
 *
 * Supported grammars (all case-insensitive, quotes optional):
 *
 *   the URL is "<exact-url>"
 *   the URL equals "<exact-url>"
 *   the URL path is "<pathname>"
 *   the URL path equals "<pathname>"
 *   the URL path starts with "<prefix>"
 *   the URL contains "<substring>"
 *   the URL has query param "<key>"
 *   the URL does not have query param "<key>"
 *   the URL query param "<key>" is "<value>"
 *   the URL query param "<key>" equals "<value>"
 */

interface UrlAssertionResult {
  matched: boolean;
  passed?: boolean;
  reason?: string;
}

const NOT_MATCHED: UrlAssertionResult = { matched: false };

/**
 * Match a quoted or unquoted token in a regex. `"foo"` or bare
 * `foo` (stops at whitespace). Wrapped in a non-capture group so
 * the inline `|` doesn't leak into surrounding alternation when
 * this fragment is concatenated into a larger pattern.
 */
const TOKEN = /(?:"([^"]+)"|(\S+))/.source;

function firstCapture(match: RegExpMatchArray, startIndex: number): string {
  return match[startIndex] ?? match[startIndex + 1] ?? '';
}

export function evaluateUrlAssertion(argument: string, currentUrl: string): UrlAssertionResult {
  const trimmed = argument.trim();

  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    // If the current URL is about:blank or otherwise unparseable,
    // any URL assertion fails deterministically.
    return {
      matched: true,
      passed: false,
      reason: `Current URL "${currentUrl}" is not a parseable http(s) URL`,
    };
  }

  // `the URL query param "<key>" is|equals "<value>"`
  // Checked before the simpler "has query param" form so the longer
  // match wins.
  const queryValueRe = new RegExp(`^the URL query param ${TOKEN} (?:is|equals) ${TOKEN}\\.?$`, 'i');
  const queryValueMatch = trimmed.match(queryValueRe);
  if (queryValueMatch) {
    const key = firstCapture(queryValueMatch, 1);
    const expected = firstCapture(queryValueMatch, 3);
    const actual = url.searchParams.get(key);
    if (actual === null) {
      return {
        matched: true,
        passed: false,
        reason: `Expected query param "${key}" to equal "${expected}", but the URL has no "${key}" param`,
      };
    }
    if (actual !== expected) {
      return {
        matched: true,
        passed: false,
        reason: `Expected query param "${key}" to equal "${expected}", got "${actual}"`,
      };
    }
    return { matched: true, passed: true };
  }

  // `the URL has query param "<key>"`
  const hasParamRe = new RegExp(`^the URL has query param ${TOKEN}\\.?$`, 'i');
  const hasParamMatch = trimmed.match(hasParamRe);
  if (hasParamMatch) {
    const key = firstCapture(hasParamMatch, 1);
    if (!url.searchParams.has(key)) {
      return {
        matched: true,
        passed: false,
        reason: `Expected query param "${key}" to be present, but the URL is ${currentUrl}`,
      };
    }
    return { matched: true, passed: true };
  }

  // `the URL does not have query param "<key>"`
  const lacksParamRe = new RegExp(`^the URL does not have query param ${TOKEN}\\.?$`, 'i');
  const lacksParamMatch = trimmed.match(lacksParamRe);
  if (lacksParamMatch) {
    const key = firstCapture(lacksParamMatch, 1);
    if (url.searchParams.has(key)) {
      return {
        matched: true,
        passed: false,
        reason: `Expected query param "${key}" to be absent, but got "${url.searchParams.get(key)}"`,
      };
    }
    return { matched: true, passed: true };
  }

  // `the URL path starts with "<prefix>"`
  const pathStartsRe = new RegExp(`^the URL path starts with ${TOKEN}\\.?$`, 'i');
  const pathStartsMatch = trimmed.match(pathStartsRe);
  if (pathStartsMatch) {
    const prefix = firstCapture(pathStartsMatch, 1);
    if (!url.pathname.startsWith(prefix)) {
      return {
        matched: true,
        passed: false,
        reason: `Expected URL path to start with "${prefix}", got "${url.pathname}"`,
      };
    }
    return { matched: true, passed: true };
  }

  // `the URL path is|equals "<pathname>"`
  const pathEqRe = new RegExp(`^the URL path (?:is|equals) ${TOKEN}\\.?$`, 'i');
  const pathEqMatch = trimmed.match(pathEqRe);
  if (pathEqMatch) {
    const expected = firstCapture(pathEqMatch, 1);
    if (url.pathname !== expected) {
      return {
        matched: true,
        passed: false,
        reason: `Expected URL path to be "${expected}", got "${url.pathname}"`,
      };
    }
    return { matched: true, passed: true };
  }

  // `the URL contains "<substring>"`
  const containsRe = new RegExp(`^the URL contains ${TOKEN}\\.?$`, 'i');
  const containsMatch = trimmed.match(containsRe);
  if (containsMatch) {
    const needle = firstCapture(containsMatch, 1);
    if (!currentUrl.includes(needle)) {
      return {
        matched: true,
        passed: false,
        reason: `Expected URL to contain "${needle}", got "${currentUrl}"`,
      };
    }
    return { matched: true, passed: true };
  }

  // `the URL is|equals "<exact>"` — checked last because the more
  // specific "URL path is" / "URL has query param" forms should win.
  const exactRe = new RegExp(`^the URL (?:is|equals) ${TOKEN}\\.?$`, 'i');
  const exactMatch = trimmed.match(exactRe);
  if (exactMatch) {
    const expected = firstCapture(exactMatch, 1);
    if (currentUrl !== expected) {
      return {
        matched: true,
        passed: false,
        reason: `Expected URL to be "${expected}", got "${currentUrl}"`,
      };
    }
    return { matched: true, passed: true };
  }

  return NOT_MATCHED;
}
