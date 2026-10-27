import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { RunRecord } from '../../../shared/contracts.js';
import { CredentialSession } from '../../../src/agent/credential-session.js';
import { createTargetPolicy } from '../../../src/policy/target-policy.js';
import { Journal } from '../../../src/executor/journal.js';
import { LOCAL_CANCEL, runExecutor, type ExecutorOutcome } from '../../../src/executor/executor.js';
import { httpLink } from '../../../src/executor/http-link.js';
import { localBrowserSide } from '../../../src/executor/browser-side.js';
import { apiBase, requireToken } from '../../cli/src/config.js';
import { apiRequest, isApiError } from '../../cli/src/api-client.js';
import { printRun } from '../../cli/src/output.js';
import { readLocalRun, type LocalRun } from './project.js';

export interface RunOptions { projectDir: string; env?: string; json?: string; failOnFlaky?: boolean; headed?: boolean }
/** The run this project folder is driving. It stays recorded until the run has ended and the instance knows it, so a
 * restarted CLI finishes it (or resends its cancellation) before starting another. It keeps what the browser side
 * needs, never a secret value, so finishing it does not depend on the project's files as they are now. */
interface ActiveRun { runId: string; projectId: string; side: BrowserConfig }
/** The target, its origins, which environment variable holds each secret, and where each secret may be sent. */
interface BrowserConfig { url: string; allowedOrigins: string[]; variables: Record<string, string>; grants: Record<string, string[]> }
interface Context {
  dataDir: string; activePath: string; token: string; base: string; headed: boolean; signal: AbortSignal;
  /** The unfinished run this invocation is driving, and its journal while this process holds it. */
  driving?: ActiveRun; held?: Journal;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const ended = (status: string) => !['running', 'queued'].includes(status);

export async function runCommand(paths: string[], options: RunOptions): Promise<void> {
  const projectDir = resolve(options.projectDir), dataDir = join(projectDir, '.zerocheck');
  mkdirSync(join(dataDir, 'runs'), { recursive: true, mode: 0o700 });
  if (!existsSync(join(dataDir, '.gitignore'))) writeFileSync(join(dataDir, '.gitignore'), '*\n');
  // From here on Ctrl-C cancels whatever this invocation drives. Each one journals the cancellation before anything
  // else, so even an exit right after it cannot let the run resume. The first then closes the browser and tells the
  // instance; a second stops waiting for the instance (the cancellation is resent next time).
  const controller = new AbortController();
  const context: Context = { dataDir, activePath: join(dataDir, 'active-run.json'), token: requireToken(), base: apiBase(), headed: options.headed === true, signal: controller.signal };
  let interrupts = 0;
  const onSignal = () => {
    keepCancelled(context);
    if (++interrupts > 1) process.exit(130);
    console.error('Cancelling…');
    controller.abort();
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  try {
    const earlier = context.driving = readActive(context.activePath);
    if (earlier) {
      // Its result is never this invocation's: the run you asked for starts only once the earlier one is over.
      console.error(`Finishing run ${earlier.runId}, which this folder started earlier.`);
      const { settled } = await drive(earlier, context);
      if (!settled || controller.signal.aborted) { process.exitCode = 2; return; }
      console.error('Starting the run you asked for.');
    }

    const local = await readLocalRun(projectDir, paths, options.env);
    if (controller.signal.aborted) { process.exitCode = 2; return; }
    const active: ActiveRun = { runId: randomUUID(), projectId: local.projectId,
      side: { url: local.config.url, allowedOrigins: local.config.allowedOrigins ?? [], variables: local.variables, grants: local.grants } };
    // Recorded, and its journal opened, before the instance hears of it: a crash or Ctrl-C from here on finds the run.
    writeActive(context.activePath, active);
    const journalPath = join(dataDir, 'runs', `${active.runId}.journal`);
    const journal = context.held = new Journal(journalPath, active.runId);
    context.driving = active;
    try { await start(active, local, options.failOnFlaky === true, controller.signal); }
    catch (error) {
      journal.release(); context.held = undefined;
      if (!(isApiError(error) && error.status < 500)) throw new Error(`Your instance could not be reached to start the run (${String(error)}). It is finished, or cancelled, the next time you run zerocheck run here.`);
      // Refused, so it does not exist on the instance: nothing is left to finish.
      context.driving = undefined; unlinkQuietly(journalPath); forget(context.activePath, active.runId);
      throw error.status === 429 ? new Error(`Your instance is running as many runs as it allows. Try again shortly. (${error.message})`) : error;
    }
    const { outcome, run, settled } = await drive(active, context, journal);
    if (options.json) {
      mkdirSync(dirname(resolve(options.json)), { recursive: true });
      writeFileSync(resolve(options.json), `${JSON.stringify(run ?? { id: active.runId, outcome }, null, 2)}\n`);
    }
    process.exitCode = settled ? exitCode(run) : 2;
  } finally { for (const signal of SIGNALS) process.off(signal, onSignal); }
}

/** Drives a run to its end, prints it, and forgets it once the instance has its outcome. */
async function drive(active: ActiveRun, context: Context, journal?: Journal): Promise<{ outcome: ExecutorOutcome; run?: RunRecord; settled: boolean }> {
  const journalPath = join(context.dataDir, 'runs', `${active.runId}.journal`);
  journal ??= new Journal(journalPath, active.runId);
  context.held = journal; context.driving = active;
  const secrets = secretValues(active.side.variables);
  const recordings = join(context.dataDir, 'video');
  const outcome = await runExecutor({
    journal, link: httpLink({ base: context.base, token: context.token, runId: active.runId }), signal: context.signal, secrets: Object.values(secrets), recordings,
    // How long a lost connection to the instance is retried before the CLI stops (the run is resumed next time).
    giveUpMs: Number(process.env.ZEROCHECK_RETRY_FOR_MS) || undefined,
    openBrowserSide: emit => browserSide(active.side, secrets, recordings, context.headed, emit),
  });
  // Recordings are uploaded as each check ends; what is left (Chromium's raw files) is not needed.
  rmSync(recordings, { recursive: true, force: true });
  context.held = undefined; // released by the executor
  // Over once the instance has the outcome: a cancellation it never acknowledged is resent next time.
  const known = outcome.status !== 'disconnected' && (outcome.status !== 'cancelled' || journal.acknowledged);
  if (known) context.driving = undefined;
  const run = await result(active, known ? 60_000 : 5_000, context.signal);
  const settled = known || (run !== undefined && ended(run.status));
  if (settled) { context.driving = undefined; forget(context.activePath, active.runId); unlinkQuietly(journalPath); }
  if (run) printRun(run);
  else console.error(`Run ${active.runId}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}.`);
  if (!settled) console.error('This run is not finished on your instance. It is resumed the next time you run zerocheck run here.');
  return { outcome, run, settled };
}

function browserSide(side: BrowserConfig, secrets: Record<string, string>, videoDir: string, headed: boolean, emit: Parameters<typeof localBrowserSide>[1]) {
  const policy = createTargetPolicy({ targetUrl: side.url, allowedOrigins: side.allowedOrigins });
  // The values and their grants live here, with the destination checks that guard them; each check gets its own session.
  const credentials = Object.keys(secrets).length ? () => new CredentialSession(secrets, side.grants, policy) : undefined;
  mkdirSync(videoDir, { recursive: true, mode: 0o700 });
  return localBrowserSide({ policy, secrets: Object.values(secrets), credentials, videoDir, headless: !headed }, emit);
}

/** The values set on this machine now. One that is missing fails only the checks that use it, on the browser side. */
function secretValues(variables: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(variables).flatMap(([name, variable]) => process.env[variable] ? [[name, process.env[variable]!]] : []));
}

/** Journals a cancellation of the run this invocation drives, synchronously, so no exit can come between. */
function keepCancelled(context: Context): void {
  const run = context.driving;
  if (!run) return;
  try {
    if (context.held) { if (!context.held.cancelled) context.held.record({ type: 'cancelled', reason: LOCAL_CANCEL }); return; }
    // Between the executor's end and this process's: the journal is free, so it is taken just to record this.
    const journal = new Journal(join(context.dataDir, 'runs', `${run.runId}.journal`), run.runId);
    try { if (!journal.cancelled) journal.record({ type: 'cancelled', reason: LOCAL_CANCEL }); } finally { journal.release(); }
  } catch (error) { console.error(`The cancellation could not be journaled: ${String(error)}`); }
}

/** Starts the run on the instance. Sent again after a lost reply, the same run is found and not started twice. After
 * Ctrl-C it stops trying, and the run is cancelled as it is; whether it started is then for the instance to say. Only
 * a refusal of the first attempt is final: after that, an earlier attempt may have started the run. */
async function start(active: ActiveRun, local: LocalRun, failOnFlaky: boolean, signal: AbortSignal): Promise<void> {
  const body = { runId: active.runId, projectId: local.projectId, environment: local.environment, trigger: process.env.CI ? 'ci' : 'cli',
    checks: local.checks, config: local.config, definitionSource: 'repository', failOnFlaky };
  for (let attempt = 0; ; attempt++) {
    try { await apiRequest('/v1/cli/runs/remote', { body, signal }); return; }
    catch (error) {
      if (isApiError(error) && error.status === 409 && attempt) return; // our first attempt arrived; its reply did not
      if (isApiError(error) && error.status < 500) throw attempt ? new Error(error.message) : error;
      if (signal.aborted) return;
      if (attempt >= 4) throw error;
      await delay(1_000 * (attempt + 1), undefined, { signal }).catch(() => {});
      if (signal.aborted) return;
    }
  }
}

/** The run as the dashboard shows it, once the instance has finished saving it. None if the instance has no such run.
 * Ctrl-C stops the wait. */
async function result(active: ActiveRun, waitMs: number, signal: AbortSignal): Promise<RunRecord | undefined> {
  const deadline = Date.now() + waitMs;
  let last: RunRecord | undefined;
  for (;;) {
    try {
      last = (await apiRequest<{ run: RunRecord }>(`/v1/cli/runs/${encodeURIComponent(active.runId)}?projectId=${encodeURIComponent(active.projectId)}`, { method: 'GET', signal })).run;
      if (ended(last.status)) return last;
    } catch (error) { if (isApiError(error) && error.status === 404) return undefined; }
    if (signal.aborted || Date.now() >= deadline) return last;
    await delay(500, undefined, { signal }).catch(() => {});
  }
}

/** The instance's verdict, which already applies --fail-on-flaky and non-blocking checks: 0 passed, 1 failed, 2 anything
 * else (cancelled, interrupted, an error, no record). */
function exitCode(run: RunRecord | undefined): number {
  return run?.status === 'passed' ? 0 : run?.status === 'failed' ? 1 : 2;
}

function readActive(path: string): ActiveRun | undefined {
  if (!existsSync(path)) return undefined;
  let active: ActiveRun | undefined;
  try { active = JSON.parse(readFileSync(path, 'utf8')) as ActiveRun; } catch { /* reported below */ }
  if (typeof active?.runId !== 'string' || typeof active.projectId !== 'string' || typeof active.side?.url !== 'string') {
    throw new Error(`${path} cannot be read. Check that no zerocheck run is using this folder, then remove it to start a new run.`);
  }
  return active;
}
/** Written in full to a file of its own, then linked into place: never half-written, and never over another run. */
function writeActive(path: string, active: ActiveRun): void {
  const temp = `${path}.${active.runId}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(active)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temp, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another zerocheck run is using this folder. Wait for it to finish.');
    throw error;
  } finally { unlinkQuietly(temp); }
}
/** Removes the record only if it is still this run's. */
function forget(path: string, runId: string): void {
  try { if ((JSON.parse(readFileSync(path, 'utf8')) as ActiveRun).runId === runId) unlinkSync(path); } catch { /* already gone */ }
}
function unlinkQuietly(path: string): void { try { unlinkSync(path); } catch { /* already gone */ } }
