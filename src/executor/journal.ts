import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RemoteReply } from '../agent/operator-protocol.js';
import { acquireRunLock, releaseRunLock } from './run-lock.js';

export type JournalEntry =
  /** First line: the run this journal belongs to, and this CLI's identity for it, kept across restarts. */
  | { type: 'header'; runId: string; executor: string }
  | { type: 'started'; id: number; kind: string }
  | { type: 'done'; id: number; reply: RemoteReply }
  /** The run's browser session was opened; after a restart it cannot be reopened. */
  | { type: 'session' }
  /** Terminal: no operation runs after this, whatever the instance says. */
  | { type: 'cancelled'; reason: string }
  | { type: 'acknowledged' };

/**
 * The CLI's record of one run, append-only and fsynced before anything it describes happens: an operation is
 * journaled as started before it is dispatched, and a cancellation is journaled before the browser closes or the
 * instance is told. A restarted CLI reads it to know what it ran, what it may have run, and whether it was cancelled.
 */
export class Journal {
  readonly executor: string;
  /** Whether this journal already existed when it was opened: the CLI restarted. */
  readonly resumed: boolean;
  sessionOpened = false;
  cancelled?: string;
  acknowledged = false;
  private readonly started = new Set<number>();
  private lastId = 0;
  private lastReply?: RemoteReply;

  /** Opening takes the run's lock first, so no other CLI reads, cuts or writes this journal at the same time. */
  constructor(private readonly path: string, runId: string) {
    acquireRunLock(`${path}.lock`);
    try {
      this.resumed = existsSync(path);
      if (!this.resumed) {
        this.executor = randomUUID();
        this.record({ type: 'header', runId, executor: this.executor });
        syncDirectory(path);
        return;
      }
      let bytes = readFileSync(path);
      // A crash mid-write can leave a final line without its newline, and nothing it described had happened yet.
      // Cut it off, so the next entry starts on a line of its own and the journal stays readable.
      const end = bytes.lastIndexOf(0x0a) + 1;
      if (end < bytes.length) { truncateSync(path, end); bytes = bytes.subarray(0, end); }
      const entries = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as JournalEntry);
      const header = entries[0];
      if (header?.type !== 'header' || header.runId !== runId) throw new Error(`The journal at ${path} belongs to another run. Use a journal for run ${runId}.`);
      this.executor = header.executor;
      for (const entry of entries.slice(1)) this.apply(entry);
    } catch (error) { this.release(); throw error; }
  }
  /** Lets another CLI open this run's journal: when this one is done with it, or after it died. */
  release(): void { releaseRunLock(`${this.path}.lock`); }

  private apply(entry: JournalEntry): void {
    if (entry.type === 'started') this.started.add(entry.id);
    else if (entry.type === 'done') { if (entry.id >= this.lastId) { this.lastId = entry.id; this.lastReply = entry.reply; } }
    else if (entry.type === 'session') this.sessionOpened = true;
    else if (entry.type === 'cancelled') this.cancelled ??= entry.reason;
    else if (entry.type === 'acknowledged') this.acknowledged = true;
  }

  /** Written in full and fsynced before the caller goes on. */
  record(entry: JournalEntry): void {
    const fd = openSync(this.path, 'a', 0o600);
    try {
      const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
      for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.apply(entry);
  }

  wasStarted(id: number): boolean { return this.started.has(id); }
  /** The highest operation with a reply, and that reply, which is resent until the instance stores it. */
  last(): { id: number; reply?: RemoteReply } { return { id: this.lastId, reply: this.lastReply }; }

}

/** A new journal's name survives a crash only once its directory is synced too. */
function syncDirectory(path: string): void {
  try { const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* not supported on every platform */ }
}
