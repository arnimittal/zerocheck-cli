import { join } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import type { TargetPolicy } from '../policy/target-policy.js';
import type { CredentialSession } from './credential-session.js';
import { ConsoleRecorder } from './console-recorder.js';
import { initializeFrameInspection } from './frame-policy.js';
import { installNavigationGuard } from './navigation-guard.js';
import { redactConsoleLogs, redactText } from '../security/redaction.js';
import { ExecutionError } from '../engine/execution-error.js';

/** What the machine running the browser supplies itself; none of it crosses the operator boundary. */
export interface SessionEnvironment {
  browser: Browser; policy: TargetPolicy; secrets: readonly string[]; credentials?: CredentialSession;
  /** The hosted private-network guard; absent where the customer's own machine runs the browser. */
  allowRequest?: (url: string) => Promise<void>;
  videoDir: string; signal?: AbortSignal;
  /** A request or popup was refused: the step fails as policy. Messages are already redacted. */
  onDenied: (message: string) => void;
  /** A guard could not do its job: the step fails as infrastructure. */
  onFailure: (message: string) => void;
}

/** Setup runs in this order and only once, each step finishing before the next starts; the page is driven only when
 * every guard is in place. A failed step leaves the session unusable: only cleanup runs. */
type Stage = 'new' | 'opening' | 'context' | 'preparing' | 'prepared' | 'paging' | 'page' | 'guarding' | 'guarded' | 'ready' | 'failed' | 'closed';

export const RECORDING_FRAME_INTERVAL_MS = 1_000;
/**
 * Chromium sends the recorder a frame only when the screen changes, and Playwright fills each gap with copies of the
 * last frame when the next frame arrives, or when the recording stops inside context close. A step watching an
 * unchanged screen (a failing Verify waits its whole window) would leave that whole gap to be encoded within the
 * context-cleanup bound, which a 30-second gap on a busy page exceeds, and the recording would be lost. A screen
 * capture makes Chromium send a frame, so gaps are encoded while the test runs (a clipped capture does not). It is
 * taken at the lowest quality through DevTools, reads no DOM, changes nothing on the page, and its image is discarded;
 * while one is pending (a busy or stuck renderer) the next is skipped. Never add `captureBeyondViewport`: it resizes
 * the page for the capture, firing resize events that can change layout and a step's verdict.
 */
export function keepRecordingCurrent(page: Page, intervalMs = RECORDING_FRAME_INTERVAL_MS): () => void {
  let client: CDPSession | undefined, pending = false, stopped = false;
  const capture = async () => {
    if (!client) {
      const created = await page.context().newCDPSession(page);
      if (stopped) { await created.detach().catch(() => {}); return; }
      client = created;
    }
    await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
  };
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    void capture().catch(() => {}).finally(() => { pending = false; });
  }, intervalMs);
  timer.unref?.();
  const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); page.off('close', stop); void client?.detach().catch(() => {}); };
  page.once('close', stop);
  return stop;
}

/**
 * The browser side of a check's session: the context, the hosted request guard, the page, the navigation guard,
 * popup blocking, console capture and video. The runner drives each step of setup and cleanup as one operation, with
 * its own time bounds, so the order and the failure messages are the runner's as before.
 */
export class BrowserSession {
  private context?: BrowserContext;
  page?: Page;
  private releaseGuard?: () => Promise<void>;
  private readonly console = new ConsoleRecorder();
  private stage: Stage = 'new';
  private recording = false;
  private stopRecordingFrames?: () => void;
  /** The latest refusal and guard failure, kept so a lost message cannot hide them. */
  denied?: string; failure?: string;
  private readonly env: SessionEnvironment;
  constructor(env: SessionEnvironment) {
    this.env = { ...env,
      onDenied: message => { this.denied = message; env.onDenied(message); },
      onFailure: message => { this.failure = message; env.onFailure(message); } };
  }

  /** Whether a new check may start: this session is unused, or finished (closed, or failed in setup). */
  get settled(): 'unused' | 'finished' | 'open' { return this.stage === 'new' ? 'unused' : this.stage === 'closed' || this.stage === 'failed' ? 'finished' : 'open'; }

  /** Every page operation needs the request guard, the navigation guard and popup blocking in place. */
  requireReady(): void {
    if (this.stage !== 'ready') throw new ExecutionError('infrastructure', `The browser page cannot be used: its session is ${this.stage === 'closed' ? 'closed' : 'not fully guarded yet'}.`);
  }
  /** The session reaches `to` only once the work succeeded; until then, and after a failure, nothing can build on it. */
  private async setup<T>(from: Stage, during: Stage, to: Stage, work: () => Promise<T>): Promise<T> {
    if (this.stage !== from) throw new ExecutionError('infrastructure', `Browser session setup out of order: cannot start ${to} from ${this.stage}.`);
    this.stage = during;
    try { const result = await work(); if (this.stage === during) this.stage = to; return result; }
    catch (error) { if (this.stage === during) this.stage = 'failed'; throw error; }
  }

  initialize(): Promise<void> { return initializeFrameInspection(); }

  async newContext(options: { viewport: { width: number; height: number }; recordVideo: boolean }): Promise<void> {
    const { viewport } = options, env = this.env;
    // No video where secrets may appear on screen, whatever the decision side asks.
    const video = options.recordVideo && !env.secrets.length;
    await this.setup('new', 'opening', 'context', async () => {
      this.context = await env.browser.newContext({ viewport, ...(video ? { recordVideo: { dir: env.videoDir, size: viewport } } : {}), ...(env.allowRequest ? { serviceWorkers: 'block' as const } : {}) });
      this.recording = video;
    });
  }

  async prepareContext(defaultTimeoutMs: number): Promise<void> {
    const context = this.requireContext(), env = this.env, allowRequest = env.allowRequest;
    await this.setup('context', 'preparing', 'prepared', async () => {
      if (allowRequest) await context.route('**/*', async route => {
        try { await allowRequest(route.request().url()); }
        catch (error) {
          env.onDenied(redactText(`Hosted private-network guard blocked request: ${String(error)}`, env.secrets));
          await route.abort('blockedbyclient').catch(() => {});
          return;
        }
        // A closing browser can reject continue(); it is not a target-policy denial.
        await route.continue().catch(() => {});
      });
      if (allowRequest) await context.routeWebSocket('**/*', async route => {
        try { await allowRequest(route.url()); }
        catch (error) {
          env.onDenied(redactText(`Hosted private-network guard blocked WebSocket: ${String(error)}`, env.secrets));
          route.close({code:1008,reason:'Hosted destination is not permitted.'});
          return;
        }
        if (env.signal?.aborted) { route.close(); return; }
        try { route.connectToServer(); }
        catch { env.onFailure('Browser WebSocket routing failed before a connection could be confirmed.'); }
      });
      context.setDefaultTimeout(defaultTimeoutMs);
    });
  }

  async newPage(): Promise<Page> {
    const context = this.requireContext();
    return this.setup('prepared', 'paging', 'page', async () => { this.page = await context.newPage(); return this.page; });
  }

  async installNavigationGuard(): Promise<void> {
    const env = this.env, page = this.requirePage();
    await this.setup('page', 'guarding', 'guarded', async () => {
      this.releaseGuard = await installNavigationGuard(page, { policy: env.policy, secrets: env.secrets, credentials: env.credentials, allowRequest: env.allowRequest,
        onDenied: error => { env.onDenied(redactText(String(error), env.secrets)); },
        onInfrastructure: error => { env.onFailure(redactText(String(error), env.secrets)); },
      });
    });
  }

  /** Same-tab flows only: any other page is refused and closed. Console errors and warnings are kept per step. */
  watch(): void {
    const page = this.requirePage();
    if (this.stage !== 'guarded') throw new ExecutionError('infrastructure', `Browser session setup out of order: cannot start ready from ${this.stage}.`);
    this.stage = 'ready';
    this.requireContext().on('page', popup => {
      if (popup === page) return;
      this.env.onDenied('TargetPolicy blocked an unsupported popup or new tab. This test runner supports same-tab flows only.');
      void popup.close().catch(() => {});
    });
    this.console.attach(page);
    if (this.recording) this.stopRecordingFrames = keepRecordingCurrent(page);
  }

  drainConsole(): ReturnType<ConsoleRecorder['drain']> { return redactConsoleLogs(this.console.drain(), this.env.secrets); }

  async closeContext(): Promise<void> { this.stage = 'closed'; this.stopRecordingFrames?.(); this.console.dispose(); await this.context?.close(); }

  /** Finalizes the recording after the context closed; the path is on this machine. */
  async saveVideo(): Promise<string | undefined> {
    const video = this.page?.video();
    if (!video) return undefined;
    const path = join(this.env.videoDir, 'recording.webm');
    await video.saveAs(path);
    return path;
  }

  async releaseNavigationGuard(): Promise<void> { await this.releaseGuard?.(); }

  private requireContext(): BrowserContext { if (!this.context) throw new ExecutionError('infrastructure', 'No browser context is open.'); return this.context; }
  private requirePage(): Page { if (!this.page) throw new ExecutionError('infrastructure', 'No browser page is open.'); return this.page; }
}
