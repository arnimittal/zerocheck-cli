import type { Page, Response, Request } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import type { OriginType } from './console-recorder.js';

/**
 * Captures response metadata for `Verify` request assertions.
 *
 * The recorder keeps a fixed-size per-page buffer so chatty pages do
 * not leak memory during a test run.
 */

interface RecordedRequest {
  method: string;
  url: string;
  status: number;
  /** Resource type reported by Playwright (xhr, fetch, document, script, ...). */
  resourceType: string;
  originType: OriginType;
  timestamp: number;
  sequence: number;
}

const DEFAULT_BUFFER_SIZE = 500;

interface NetworkRecorderOptions {
  maxSize?: number;
  firstPartyOrigin?: string;
  startUrl?: string;
}

export class NetworkRecorder {
  private buffer: RecordedRequest[] = [];
  private readonly maxSize: number;
  private attached = false;
  private sequence = 0;
  private boundary = 0;
  private starts = new WeakMap<Request, number>();
  private pending = new Map<Request, number>();
  private cohortStarted = -Infinity;
  private pendingOverflow = false;
  private firstPartyOrigin: string | null = null;

  constructor(opts: number | NetworkRecorderOptions = DEFAULT_BUFFER_SIZE) {
    if (typeof opts === 'number') {
      this.maxSize = opts;
      return;
    }
    this.maxSize = opts.maxSize ?? DEFAULT_BUFFER_SIZE;
    this.firstPartyOrigin = originOf(opts.firstPartyOrigin ?? '') ?? originOf(opts.startUrl ?? '');
  }

  /** Attach once per page; subsequent calls are no-ops. */
  attach(page: Page): void {
    if (this.attached) return;
    this.attached = true;
    page.on('request', request => {
      this.starts.set(request, ++this.sequence);
      try {
        const frame = request.frame();
        const inCohort = request.isNavigationRequest() && frame === page.mainFrame()
          || Date.now() - this.cohortStarted <= 250 && ['fetch', 'xhr'].includes(request.resourceType());
        if (inCohort) {
          if (this.pending.size < this.maxSize) this.pending.set(request, this.sequence);
          else this.pendingOverflow = true;
        }
      } catch { /* Requests without a browser frame cannot settle that frame's outcome. */ }
    });
    page.on('requestfinished', request => this.pending.delete(request));
    page.on('requestfailed', request => this.pending.delete(request));
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) { this.pending.clear(); this.pendingOverflow = false; this.cohortStarted = Date.now(); }
    });
    page.on('response', (response) => this.record(response, page));
  }

  private record(response: Response, page: Page): void {
    try {
      const request = response.request();
      const url = response.url();
      const resourceType = request.resourceType();
      if (resourceType === 'document' && !this.firstPartyOrigin && isMainFrameResponse(response, page)) {
        this.firstPartyOrigin = originOf(url) ?? this.firstPartyOrigin;
      }
      const entry: RecordedRequest = {
        method: request.method().toUpperCase(),
        url,
        status: response.status(),
        resourceType,
        originType: classifyOrigin(url, this.firstPartyOrigin),
        timestamp: Date.now(),
        sequence: this.starts.get(request) ?? ++this.sequence,
      };
      this.buffer.push(entry);
      if (this.buffer.length > this.maxSize) {
        this.buffer.shift();
      }
    } catch {
      // Aborted responses can throw here. Recording is best effort.
    }
  }

  /** All recorded entries, in order of receipt. Callers must not mutate. */
  getAll(): ReadonlyArray<RecordedRequest> {
    return this.buffer;
  }

  /**
   * Find recorded requests matching a filter. The URL filter is a
   * substring match against the full URL — authors can write
   * `/api/orders` to match any host with that path, or
   * `https://api.example.com/v2/orders` for exact targeting. Method
   * and status, when provided, must match exactly.
   */
  query(filter: { method?: string; urlContains: string; status?: number }): RecordedRequest[] {
    const needle = filter.urlContains;
    const method = filter.method?.toUpperCase();
    return this.buffer.filter((r) => {
      if (r.sequence <= this.boundary) return false;
      if (!r.url.includes(needle)) return false;
      if (method && r.method !== method) return false;
      if (filter.status != null && r.status !== filter.status) return false;
      return true;
    });
  }

  /** Responses to requests started before this action cannot prove its outcome. */
  markActionBoundary(): void { this.boundary = this.sequence; this.cohortStarted = Date.now(); this.pending.clear(); this.pendingOverflow = false; }

  /** Read-only readiness heuristic, not causal outcome evidence. Watch the short
   * dispatch cohort (including cross-origin APIs), not perpetual network idle. */
  async settleAction(deadline: number, signal?: AbortSignal): Promise<void> {
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (Date.now() < this.cohortStarted + 250 || this.pendingOverflow || [...this.pending.values()].some(sequence => sequence > this.boundary)) quietSince = Date.now();
      else if (Date.now() - quietSince >= 150) return;
      await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }

  /** Clear the buffer — used when reusing a recorder across tests. */
  clear(): void {
    this.buffer = [];
    this.pending.clear(); this.pendingOverflow = false;
  }
}

function isMainFrameResponse(response: Response, page: Page): boolean {
  try {
    const frame = response.frame();
    return frame === page.mainFrame();
  } catch {
    return false;
  }
}

function originOf(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function classifyOrigin(rawUrl: string, firstPartyOrigin: string | null): OriginType {
  const origin = originOf(rawUrl);
  if (!origin || !firstPartyOrigin) return 'unknown';
  return origin === firstPartyOrigin ? 'first_party' : 'third_party';
}
