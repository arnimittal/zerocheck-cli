import type { Page } from 'playwright';

export type OriginType = 'first_party' | 'third_party' | 'unknown';

export interface ConsoleLog {
  level: 'error' | 'warning';
  text: string;
  sourceUrl: string | null;
  originType: OriginType;
  at: number; // Date.now() timestamp
}

/**
 * Capture browser console errors and warnings during a test run. Attach
 * once per Page; the recorder accumulates messages until drained. Call
 * `drain()` at step boundaries to collect the messages that fired since
 * the last drain — the runner attaches those to the step's StepResult.
 *
 * Only `error` and `warning` levels are captured. Everything else (log,
 * info, debug) is discarded because the signal-to-noise ratio on those
 * is too low to surface in PR comments.
 */
/** Cap the buffer between drains. A page that spams console.error
 *  thousands of times between step boundaries would otherwise bloat
 *  memory. 500 messages at ~2KB each = ~1MB ceiling per test. */
const MAX_BUFFER = 500;

export class ConsoleRecorder {
  private buffer: ConsoleLog[] = [];
  private detach: (() => void) | null = null;
  private dropped = 0;

  attach(page: Page): void {
    if (this.detach) return; // idempotent

    const handler = (msg: import('playwright').ConsoleMessage) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      if (this.buffer.length >= MAX_BUFFER) {
        // Silent cap — the next drain reports the drop count so callers
        // know their signal is truncated.
        this.dropped += 1;
        return;
      }
      // msg.text() can be expensive on large values; truncate defensively.
      const text = msg.text().slice(0, 2000);
      const sourceUrl = msg.location().url || null;
      this.buffer.push({
        level: type,
        text,
        sourceUrl,
        originType: classifyOrigin(sourceUrl, page.url()),
        at: Date.now(),
      });
    };
    page.on('console', handler);
    this.detach = () => page.off('console', handler);
  }

  /** Return the messages that arrived since the last drain, then clear. */
  drain(): Array<{ level: 'error' | 'warning'; text: string; sourceUrl: string | null; originType: OriginType }> {
    const out = this.buffer.map((m) => ({
      level: m.level,
      text: m.text,
      sourceUrl: m.sourceUrl,
      originType: m.originType,
    }));
    if (this.dropped > 0) {
      out.push({
        level: 'warning',
        text: `[console-recorder] ${this.dropped} message(s) dropped (buffer full)`,
        sourceUrl: null,
        originType: 'unknown',
      });
    }
    this.buffer = [];
    this.dropped = 0;
    return out;
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
    this.buffer = [];
    this.dropped = 0;
  }
}

function classifyOrigin(sourceUrl: string | null, pageUrl: string): OriginType {
  if (!sourceUrl) return 'unknown';
  try {
    const source = new URL(sourceUrl);
    const page = new URL(pageUrl);
    if (!['http:', 'https:'].includes(source.protocol)) return 'unknown';
    if (!['http:', 'https:'].includes(page.protocol)) return 'unknown';
    return source.origin === page.origin ? 'first_party' : 'third_party';
  } catch {
    return 'unknown';
  }
}
