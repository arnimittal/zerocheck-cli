import { readFileSync, rmSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ActionExecutionError } from '../agent/action-executor.js';
import { ExecutionError } from '../engine/execution-error.js';
import { delayed, encodeError, LINK_PROTOCOL, RUN_ENDS, type CancelMessage, type NextAnswer, type NextMessage, type OperatorEvent, type OperatorRequest, type OperatorResponse, type RemoteReply, type RunEnd } from '../agent/operator-protocol.js';
import { containsSecretValue, redactionValues, redactText } from '../security/redaction.js';
import type { Journal } from './journal.js';

export type { NextAnswer, RunEnd } from '../agent/operator-protocol.js';

/** The instance refused this CLI for good (another executor, an unknown run, no access): retrying cannot help. */
export class InstanceRefusal extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/** The CLI's view of the instance. Either call may throw when a request or its reply is lost; both are resent. */
export interface InstanceLink {
  /** Delivers the last reply (resent until the instance has stored it) and returns the next operation or the run's end. */
  next(message: NextMessage, signal: AbortSignal): Promise<NextAnswer>;
  /** Resolves only when the instance acknowledges the cancellation; it carries the last reply too. */
  cancel(message: CancelMessage): Promise<void>;
  /** Stores evidence under the name the instance chose, in the run's artifacts. Sending the same bytes again is harmless. */
  upload(name: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}

/** The browser side on this machine: an OperatorHost with its session, opened the first time it is needed. */
export interface BrowserSide { handle(request: OperatorRequest): Promise<OperatorResponse>; close(): Promise<void> }

export interface ExecutorOptions {
  journal: Journal; link: InstanceLink;
  openBrowserSide: (emit: (event: OperatorEvent) => void) => BrowserSide;
  /** Configured secret values on this machine; nothing the CLI sends contains them. */
  secrets: readonly string[];
  /** Ctrl-C, SIGTERM or a CI timeout. */
  signal?: AbortSignal;
  /** Where the browser side keeps its recordings: nothing outside it is ever uploaded. */
  recordings?: string;
  /** The largest recording uploaded; a larger one stays here, reported as not uploaded. */
  maxVideoBytes?: number;
  retryDelayMs?: number; giveUpMs?: number; maxRedeliveries?: number;
}
export interface ExecutorOutcome { status: RunEnd | 'disconnected'; reason?: string; executed: number[] }

export const LOCAL_CANCEL = 'Cancelled on this machine.';

/**
 * The thin CLI's loop: it decides nothing. It asks the instance for the next operation, runs each operation ID at most
 * once against its own browser, journals before and after, and resends its last reply until the instance stores it.
 * A cancellation is journaled before the browser closes and before the instance is told, and a journal that holds one
 * never runs another operation, so a cancelled run cannot resume even if the instance never heard of the cancellation.
 */
export async function runExecutor(options: ExecutorOptions): Promise<ExecutorOutcome> {
  const { journal, link } = options, executed: number[] = [];
  // A browser session opened by an earlier process ended with it; one this process opens is its own.
  const sessionLost = journal.resumed && journal.sessionOpened;
  let browser: BrowserSide | undefined;
  const background: OperatorEvent[] = [];
  let current: OperatorEvent[] | undefined;
  const emit = (event: OperatorEvent) => { (current ?? background).push(event); };
  const closeBrowser = async () => { const side = browser; browser = undefined; await side?.close().catch(() => {}); };
  const local = new AbortController();
  // Kept here too, so a journal that cannot be written still stops this process.
  let cancelledHere = false, journalFailure: string | undefined;
  const cancelled = () => cancelledHere || journal.cancelled !== undefined;
  const onAbort = () => {
    cancelledHere = true;
    // Persist first, so even a crash right after this cannot let the run resume; then stop the browser at once.
    try { if (!journal.cancelled) journal.record({ type: 'cancelled', reason: LOCAL_CANCEL }); }
    catch (error) { journalFailure = `The cancellation could not be journaled: ${String(error)}`; }
    local.abort(); void closeBrowser();
  };

  const cancel = async (): Promise<ExecutorOutcome> => {
    await closeBrowser();
    if (!journal.acknowledged) {
      const { id: after, reply } = journal.last();
      try {
        await retry(() => link.cancel({ protocol: LINK_PROTOCOL, executor: journal.executor, reason: journal.cancelled ?? LOCAL_CANCEL, after, ...reply ? { reply } : {} }), options);
        if (journal.cancelled) journal.record({ type: 'acknowledged' });
      } catch (error) {
        // An instance with no such run (its start never arrived) has nothing to stop. Otherwise it is still cancelled
        // here, and the instance interrupts the run when its hold time runs out, and never passes it.
        if (error instanceof InstanceRefusal && error.status === 404 && journal.cancelled) journal.record({ type: 'acknowledged' });
      }
    }
    return { status: 'cancelled', reason: journalFailure ?? journal.cancelled ?? LOCAL_CANCEL, executed };
  };

  try {
    if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
    let { id: after, reply: pending } = journal.last(), redeliveries = 0, asked = 0, askedAt = 0;
    for (;;) {
      if (cancelled()) return await cancel();
      let answer: NextAnswer;
      try {
        answer = await retry(async () => { asked = performance.now(); askedAt = Date.now(); return readAnswer(await link.next({ protocol: LINK_PROTOCOL, executor: journal.executor, after, ...pending ? { reply: pending } : {} }, local.signal)); }, options, local.signal);
      } catch (error) {
        if (cancelled()) return await cancel();
        await closeBrowser();
        return { status: error instanceof InstanceRefusal ? 'interrupted' : 'disconnected', reason: clip(error, options.secrets), executed };
      }
      // An answer that arrives after a cancellation is ignored: nothing runs once it is journaled.
      if (cancelled()) return await cancel();
      if (answer.type === 'wait') continue;
      if (answer.type === 'finished') {
        if (answer.status === 'cancelled') {
          journal.record({ type: 'cancelled', reason: answer.reason ?? 'Cancelled by the instance.' });
          journal.record({ type: 'acknowledged' });
          return await cancel();
        }
        await closeBrowser();
        return { status: answer.status, reason: answer.reason, executed };
      }
      if (answer.type === 'retire') {
        // Withdrawn: its check stopped before this CLI acknowledged it. Nothing runs for it, even if it was never received;
        // one this CLI started before a crash is still reported as possibly run.
        const id = answer.id;
        if (id <= after) {
          if (++redeliveries > (options.maxRedeliveries ?? 20)) { await closeBrowser(); return { status: 'interrupted', reason: 'The instance kept resending an operation that already ran.', executed }; }
          await delay(options.retryDelayMs ?? 1_000, undefined, { signal: local.signal }).catch(() => {});
          continue;
        }
        redeliveries = 0;
        if (id !== after + 1) { await closeBrowser(); return { status: 'interrupted', reason: `Operation ${id} skips ${after + 1}.`, executed }; }
        const reply = journal.wasStarted(id) ? unfinished(id, 'act') : refused(id, 'Withdrawn before it ran: its check had already stopped.');
        journal.record({ type: 'done', id, reply });
        after = id; pending = reply;
        continue;
      }
      const { request } = answer, id = request.id, kind = request.operation.kind;
      if (id <= after) {
        // Delivered again: it ran once already, and the next request resends its reply. An instance that keeps doing
        // this is broken; stop rather than loop.
        if (++redeliveries > (options.maxRedeliveries ?? 20)) { await closeBrowser(); return { status: 'interrupted', reason: 'The instance kept resending an operation that already ran.', executed }; }
        await delay(options.retryDelayMs ?? 1_000, undefined, { signal: local.signal }).catch(() => {});
        continue;
      }
      redeliveries = 0;
      if (id !== after + 1) { await closeBrowser(); return { status: 'interrupted', reason: `Operation ${id} skips ${after + 1}.`, executed }; }
      let reply: RemoteReply;
      if (journal.wasStarted(id)) {
        // Started but never finished: the CLI stopped mid-operation. Report it as possibly run, and never run it again.
        reply = unfinished(id, kind);
        journal.record({ type: 'done', id, reply });
      } else if (sessionLost) {
        // The run's browser ended with the CLI's previous process: nothing more can run for it.
        reply = refused(id, 'The browser for this run ended when the CLI stopped. The run cannot continue.');
        journal.record({ type: 'done', id, reply });
      } else {
        journal.record({ type: 'started', id, kind });
        current = background.splice(0);
        let response: OperatorResponse;
        // Its budget counts from when the instance handed it out, and the answer may have been held up on the way. The time
        // since this request was sent, less the time the instance says it held it, is time on the way, measured on this
        // machine's clocks alone: no clocks need to agree, and any delay before the request arrived only shortens the
        // budget. The larger of two clocks: the monotonic one stops while the machine sleeps, and the wall clock can be
        // set back. An act whose time has run out is refused before it is dispatched.
        const since = Math.max(performance.now() - asked, Date.now() - askedAt);
        const operation = delayed(request.operation, since - answer.waitedMs);
        const received = Date.now();
        try { browser ??= options.openBrowserSide(emit); response = await browser.handle({ ...request, operation }); }
        catch (error) { response = unfinished(id, kind, `The browser side failed (${clip(error, options.secrets)}) during this`).reply; current.push({ type: 'mutation' }); }
        if (operation.kind === 'saveVideo') response = await uploadRecording(operation, received, response, options, local.signal);
        reply = protect({ reply: response, events: current }, kind, options.secrets); current = undefined;
        if (kind === 'newContext' && response.ok) journal.record({ type: 'session' });
        journal.record({ type: 'done', id, reply });
        executed.push(id);
      }
      after = id; pending = reply;
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await closeBrowser();
    journal.release();
  }
}

/** Retries a lost request or reply until it gets through, the run is cancelled here, or the time runs out. */
async function retry<T>(work: () => Promise<T>, options: ExecutorOptions, signal?: AbortSignal, deadline = Date.now() + (options.giveUpMs ?? 300_000)): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    try { return await work(); }
    catch (error) {
      if (error instanceof InstanceRefusal || signal?.aborted || Date.now() >= deadline) throw error;
      await delay(options.retryDelayMs ?? 1_000, undefined, signal ? { signal } : undefined);
    }
  }
}

function readAnswer(value: unknown): NextAnswer {
  const answer = value as NextAnswer | undefined;
  if (answer?.type === 'wait') return answer;
  if (answer?.type === 'retire' && Number.isSafeInteger(answer.id) && answer.id > 0) return answer;
  if (answer?.type === 'finished' && RUN_ENDS.includes(answer.status)) return answer;
  if (answer?.type === 'operation' && Number.isSafeInteger(answer.request?.id) && answer.request.id > 0
    && typeof answer.request.operation?.kind === 'string' && Array.isArray(answer.request.controls) && Number.isFinite(answer.waitedMs) && answer.waitedMs >= 0) return answer;
  throw new Error('The instance sent an unreadable answer.');
}

/** 30 MB: a few minutes of a check's recording. The instance accepts up to 40 MB. */
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
/** When the instance names no budget for an upload. */
const UPLOAD_MS = 30_000;

/**
 * A recording stays on this machine until it is uploaded under the name the instance chose; its local path is never
 * sent. Only a file inside the browser side's recordings directory is uploaded, and it is removed here once it is.
 */
async function uploadRecording(operation: { upload?: string; budgetMs?: number }, received: number, response: OperatorResponse, options: ExecutorOptions, signal: AbortSignal): Promise<OperatorResponse> {
  if (!response.ok || response.value === undefined) return response;
  const fail = (message: string): OperatorResponse => ({ id: response.id, ok: false, status: response.status, error: encodeError(new ExecutionError('infrastructure', message)) });
  const path = resolve(String(response.value)), name = operation.upload;
  if (!options.recordings || !path.startsWith(`${resolve(options.recordings)}${sep}`)) return fail('The recording is not in this machine\'s recordings directory, so it was not uploaded.');
  try {
    if (typeof name !== 'string') return { ...response, value: undefined };
    let bytes: Buffer;
    // A file-system error names the local path, which is never sent.
    try {
      const limit = options.maxVideoBytes ?? MAX_VIDEO_BYTES, size = statSync(path).size;
      if (size > limit) return fail(`The recording is ${Math.ceil(size / 1_048_576)} MB, over the ${Math.round(limit / 1_048_576)} MB upload limit, so it was not uploaded.`);
      bytes = readFileSync(path);
    } catch { return fail('The recording could not be read on this machine.'); }
    // Within the instance's budget, which it counts from when it asked: it stops waiting then, and the next check is
    // queued behind this one. Ctrl-C stops it too.
    const deadline = received + (operation.budgetMs ?? UPLOAD_MS);
    await retry(() => options.link.upload(name, bytes, AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now())))])), options, signal, deadline);
    return { ...response, value: name };
  } catch (error) { return fail(`The recording could not be uploaded: ${clip(error, options.secrets)}`); }
  finally { rmSync(path, { force: true }); }
}

/** An error's text, cleared of secrets before it is cut, so no part of a value survives the cut. */
function clip(error: unknown, secrets: readonly string[]): string { return redactText(String(error), secrets).slice(0, 300); }

const UNKNOWN_STATUS = { url: '', closed: true, mutation: true, actionSequence: 0 };
/** What happened is unknown: an action may have run, and anything may have been written. */
function unfinished(id: number, kind: string, why = 'The CLI stopped during this'): RemoteReply {
  const error = kind === 'act'
    ? new ActionExecutionError(`${why} action, so it may have run. It was not run again.`,
      { action: 'unknown', phase: 'outcome_unknown', effect: 'possible_write', actionObserved: false, outcomeObserved: false, sources: [] }, undefined, 'infrastructure')
    : new ExecutionError('infrastructure', `${why} operation. It was not run again.`);
  return { reply: { id, ok: false, status: UNKNOWN_STATUS, error: encodeError(error) }, events: [{ type: 'mutation' }] };
}
function refused(id: number, message: string): RemoteReply {
  return { reply: { id, ok: false, status: UNKNOWN_STATUS, error: encodeError(new ExecutionError('infrastructure', message)) }, events: [] };
}

/**
 * No configured secret value leaves this machine. Every string in the reply and its events is cleared of them; only
 * screenshot pixels are left alone, as they are masked at capture and are not text. Configured values only, as on the
 * instance, so URLs keep their parameters and hints keep their keys. A reply that still holds a secret is not sent.
 */
function protect(remote: RemoteReply, kind: string, secrets: readonly string[]): RemoteReply {
  const values = redactionValues(secrets);
  if (!values.length) return remote;
  const clear = <T>(value: T): T => {
    if (typeof value === 'string') return values.reduce((text, secret) => text.split(secret).join('[redacted]'), value as string) as T;
    if (Array.isArray(value)) return value.map(clear) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, clear(field)])) as T;
    return value;
  };
  // Set screenshot pixels aside, clear everything else, check, then put the pixels back.
  const reply = remote.reply as OperatorResponse & { value?: unknown };
  const pixels = kind === 'screenshot' ? reply.value : kind === 'observe' ? (reply.value as { screenshot?: unknown } | undefined)?.screenshot : undefined;
  const textual = pixels === undefined ? reply : { ...reply, value: kind === 'screenshot' ? undefined : { ...reply.value as object, screenshot: undefined } };
  const cleared = { reply: clear(textual), events: clear(remote.events) } as RemoteReply;
  // Withheld, the reply still says what matters: an action may have run.
  if (containsSecretValue(cleared, secrets)) return unfinished(reply.id, kind, 'A secret could not be cleared from the reply to this');
  if (pixels === undefined) return cleared;
  const value = kind === 'screenshot' ? pixels : { ...(cleared.reply as { value: object }).value, screenshot: pixels };
  return { ...cleared, reply: { ...cleared.reply, value } as OperatorResponse };
}
