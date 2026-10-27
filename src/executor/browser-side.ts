import { chromium, type Browser } from 'playwright';
import { BrowserSession, type SessionEnvironment } from '../agent/browser-session.js';
import { OperatorHost } from '../agent/operator-host.js';
import { OperatorState, type OperatorOptions } from '../agent/page-operator.js';
import type { OperatorEvent } from '../agent/operator-protocol.js';
import type { CredentialSession } from '../agent/credential-session.js';
import type { BrowserSide } from './executor.js';

/** What this machine decides for itself: the policy, the secrets and their grants, where video goes. Each check gets a
 * credential session of its own, as a hosted check does, so nothing bound in one check's page reaches the next. */
export type LocalBrowserConfig = Omit<SessionEnvironment, 'browser' | 'onDenied' | 'onFailure' | 'allowRequest' | 'credentials'> & Pick<OperatorOptions, 'logger'>
  & { headless?: boolean; credentials?: () => CredentialSession };

/**
 * The thin CLI's browser side: its own Chromium, launched on the first operation, and an OperatorHost that opens a
 * fresh browser session for each check. One configuration sets the policy, secrets and credentials for every part.
 */
export function localBrowserSide(config: LocalBrowserConfig, emit: (event: OperatorEvent) => void): BrowserSide {
  let launched: Promise<Browser> | undefined, host: OperatorHost | undefined;
  const options: OperatorOptions = { targetPolicy: config.policy, secrets: config.secrets, logger: config.logger, signal: config.signal };
  return {
    async handle(request) {
      // The CLI handles Ctrl-C itself, in its own order: the cancellation is journaled before the browser closes.
      launched ??= chromium.launch({ headless: config.headless ?? true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      const browser = await launched;
      host ??= new OperatorHost(new OperatorState(), options, emit, { sessions: () => {
        const credentials = config.credentials?.();
        return { credentials, session: new BrowserSession({ ...config, credentials, browser,
          onDenied: message => emit({ type: 'denied', message }), onFailure: message => emit({ type: 'failure', message }) }) };
      } });
      return host.handle(request);
    },
    async close() { const browser = await launched?.catch(() => undefined); launched = undefined; await browser?.close(); },
  };
}
