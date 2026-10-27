import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

/**
 * One CLI per run's journal, across processes on one machine. Node has no kernel file lock, so this uses two lock
 * files and only atomic file-system steps:
 * - The lock appears complete or not at all: its content is written and synced to a private temp file, then
 *   hard-linked into place, which fails if the lock exists.
 * - A lock whose owner is gone is taken over only by the holder of the recovery lock (created the same way). Under it,
 *   the lock is read again and replaced by an atomic rename only if it is still the gone owner's. The lock path is
 *   never empty during a takeover, so no third process can create it meanwhile.
 * - A lock is removed only while it still holds its owner's token, so nobody removes another's lock.
 * - When ownership is uncertain (a lock from another machine, an unreadable lock, or a recovery lock whose owner
 *   stopped mid-takeover), opening is refused with what to check, never guessed.
 * The journal's directory belongs on the machine that runs the CLI: a lock written elsewhere is never taken over.
 * Containers that share both a host name (for example host networking) and a mounted journal directory look like one
 * machine without seeing each other's processes, so keep journals out of directories shared that way.
 */
export class RunLockError extends Error {}

export type LockPoint = 'prepared' | 'busy' | 'found-stale' | 'recovery-busy' | 'recovering' | 'replaced';
/** Test seam: called at each step, so a test can stop two processes at the same point and let them go in any order. */
export const lockProbe: { at?: (point: LockPoint) => void } = {};

interface Owner { host: string; boot?: string; pid: number; start: number; token: string }
type Found = { owner: Owner } | { missing: true } | { unreadable: true };

const HOST = hostname();
const BOOT = (() => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; } catch { return undefined; } })();
/** When this process started, on the machine's monotonic clock: the same for every thread and module copy of the
 * process, whatever path it opened the journal by, and different for an earlier process that had the same pid (a
 * restarted container). */
const START = Number(process.hrtime.bigint() / 1_000_000n) - Math.round(process.uptime() * 1000);
const SAME_PROCESS_MS = 1_000;
/** The locks this module holds, by the path they were opened with, with the token for each, for releasing them. */
const held = new Map<string, string>();

export function acquireRunLock(path: string): void {
  const token = randomUUID(), mine = `${path}.${token}.tmp`;
  writeSynced(mine, { host: HOST, ...BOOT ? { boot: BOOT } : {}, pid: process.pid, start: START, token });
  try {
    // A lock that vanishes between our attempt and our read was released or taken over just then: try again.
    lockProbe.at?.('prepared');
    for (let attempt = 0; attempt < 5; attempt++) {
      if (tryLink(mine, path)) { held.set(path, token); return; }
      lockProbe.at?.('busy');
      const found = read(path);
      if ('missing' in found) continue;
      if ('unreadable' in found) throw new RunLockError(`The lock ${path} cannot be read, so it is not clear who owns this run. Make sure no Zerocheck CLI is running it, then delete ${path} (never the journal) and try again.`);
      assertGone(found.owner, path);
      lockProbe.at?.('found-stale');
      if (takeOver(path, found.owner, mine, token)) { held.set(path, token); return; }
    }
    throw new RunLockError(`The lock ${path} kept changing while this CLI tried to open the run. Make sure no other Zerocheck CLI is running it, then try again.`);
  } finally { removeQuietly(mine); }
}

/** Removes the lock only if it is still this process's; anything else is left as it is. */
export function releaseRunLock(path: string): void {
  const token = held.get(path);
  if (token === undefined) return;
  held.delete(path);
  const found = read(path);
  if ('owner' in found && found.owner.token === token) removeQuietly(path);
}

/** Refuses unless the owner is certainly gone. */
function assertGone(owner: Owner, path: string): void {
  const running = `Another Zerocheck CLI (process ${owner.pid}) is already running this run.`;
  if (owner.host !== HOST) throw new RunLockError(`The lock ${path} was written on another machine (${owner.host}), so this one cannot tell whether that CLI is still running. Keep each run's journal on the machine that runs it; if that CLI has stopped, delete ${path} (never the journal) and try again.`);
  if (owner.boot && BOOT && owner.boot !== BOOT) return; // this machine has restarted since: every process then is gone
  if (owner.pid === process.pid) {
    if (Math.abs(owner.start - START) < SAME_PROCESS_MS) throw new RunLockError(running); // this very process, by any path or thread
    return; // an earlier process with this pid, such as before a container restart
  }
  if (isRunning(owner.pid)) throw new RunLockError(`${running} If process ${owner.pid} is not a Zerocheck CLI, delete ${path} (never the journal) and try again.`);
}

/** Replaces a gone owner's lock under the recovery lock. False if the lock changed meanwhile: try again from the start. */
function takeOver(path: string, gone: Owner, mine: string, token: string): boolean {
  const recovery = `${path}.recovery`, claim = `${recovery}.${token}.tmp`;
  writeSynced(claim, { host: HOST, ...BOOT ? { boot: BOOT } : {}, pid: process.pid, start: START, token });
  try {
    if (!tryLink(claim, recovery)) {
      lockProbe.at?.('recovery-busy');
      const other = read(recovery);
      if ('missing' in other) return false; // that takeover just finished
      if ('owner' in other) {
        try { assertGone(other.owner, recovery); }
        catch (error) {
          if (other.owner.host !== HOST) throw error; // says which machine, and what to delete
          throw new RunLockError(`Another Zerocheck CLI (process ${other.owner.pid}) is taking over this run's lock. If process ${other.owner.pid} is not a Zerocheck CLI, delete ${recovery} and ${path} (never the journal) and try again.`);
        }
      }
      throw new RunLockError(`A Zerocheck CLI stopped while taking over the lock for this run. Make sure no Zerocheck CLI is running it, then delete ${recovery} and ${path} (never the journal) and try again.`);
    }
  } finally { removeQuietly(claim); }
  try {
    lockProbe.at?.('recovering');
    // Under the recovery lock nobody else replaces the lock, so this second read decides.
    const current = read(path);
    if (!('owner' in current) || current.owner.token !== gone.token) return false;
    renameSync(mine, path);
    lockProbe.at?.('replaced');
    return true;
  } finally {
    // Ours: linked above, and nobody else ever removes or replaces a recovery lock while its owner runs.
    removeQuietly(recovery);
  }
}

function writeSynced(path: string, owner: Owner): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(owner)); fsyncSync(fd); } finally { closeSync(fd); }
}
function tryLink(from: string, to: string): boolean {
  try { linkSync(from, to); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') throw new RunLockError(`The folder of ${to} does not support hard links, which the run lock needs. Keep the CLI's data on a local disk.`);
    throw error;
  }
}
function read(path: string): Found {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }; return { unreadable: true }; }
  try {
    const owner = JSON.parse(text) as Owner;
    const valid = typeof owner.host === 'string' && Number.isSafeInteger(owner.pid) && owner.pid > 0 && Number.isFinite(owner.start) && typeof owner.token === 'string';
    return valid ? { owner } : { unreadable: true };
  } catch { return { unreadable: true }; }
}
function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function removeQuietly(path: string): void { try { unlinkSync(path); } catch { /* already gone */ } }
