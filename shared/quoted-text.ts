/** Literal spans preserve source positions and data; ordinary word apostrophes are not delimiters. */
export interface QuotedSpan {
  start: number; end: number; interiorStart: number; interiorEnd: number;
  opening: string; closing: string; raw: string; closed: boolean;
}
export function scanQuotedText(source: string): { spans: QuotedSpan[]; unmatched: boolean } {
  const spans: QuotedSpan[] = [];
  const word = (char: string | undefined) => Boolean(char && /[\p{L}\p{M}\p{N}_]/u.test(char));
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    const opening = source[i];
    const closing = opening === '“' ? '”' : opening === '‘' ? '’' : opening;
    if (!['"', "'", '“', '‘'].includes(opening) || word(source[i - 1])) continue;
    const start = i; let escaped = false; let closed = false;
    for (i++; i < source.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (source[i] === '\\') { escaped = true; continue; }
      if (source[i] === closing) {
        if ((closing === "'" || closing === '’') && word(source[i - 1]) && word(source[i + 1])) continue;
        closed = true; break;
      }
    }
    spans.push({ start, end: closed ? i + 1 : source.length, interiorStart: start + 1,
      interiorEnd: i, opening, closing, raw: source.slice(start + 1, i), closed });
  }
  return { spans, unmatched: spans.some(span => !span.closed) };
}
/** Mask literal spans without changing offsets; unmatched literals are still opaque. */
export function outsideQuotedText(source: string): string {
  // String offsets are UTF-16 offsets; do not split surrogate pairs before masking.
  let result = source;
  for (const span of scanQuotedText(source).spans.slice().reverse()) result = result.slice(0, span.start) + ' '.repeat(span.end - span.start) + result.slice(span.end);
  return result;
}
/** Decode only a recognized complete literal, never prose or source outside it. */
export function quotedValue(span: QuotedSpan): string | undefined {
  if (!span.closed) return undefined;
  if (span.opening === '"') { try { return JSON.parse(`"${span.raw}"`) as string; } catch { return undefined; } }
  return span.raw.replace(/\\([\\'‘’“”])/g, '$1');
}
