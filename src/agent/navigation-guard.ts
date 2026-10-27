import type { Page } from 'playwright';
import type { TargetPolicy } from '../policy/target-policy.js';
import { assertSecretNavigationAllowed } from './credential-boundary.js';
import type { CredentialSession } from './credential-session.js';

/** Chromium may discard an authorized paused request while a redirect advances. */
function isExpiredPausedRequest(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.split('\n', 1)[0].replace(/^cdpSession\.send: /, '');
  return message === 'Protocol error (Fetch.continueRequest): Invalid InterceptionId.';
}

/** Playwright route handlers see the first redirect request only. Chromium Fetch pauses each hop. */
export async function installNavigationGuard(page: Page, options: {
  policy: TargetPolicy; secrets: readonly string[]; allowRequest?: (url: string) => Promise<void>;
  credentials?: CredentialSession;
  onDenied: (error: unknown) => void;
  onInfrastructure: (error: unknown) => void;
}): Promise<() => Promise<void>> {
  const session = await page.context().newCDPSession(page);
  let disposed = false;
  let active = false;
  let stopped = false;
  const stop = async (error: unknown) => {
    if (disposed || stopped || page.isClosed()) return;
    stopped = true; active = false;
    options.onInfrastructure(error);
    await page.close().catch(() => {});
  };
  session.on('close', () => { void stop(new Error('Navigation guard session closed while the browser page remained active.')); });
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const mainFrameId = frameTree.frame.id;
    session.on('Fetch.requestPaused', async event => {
      if (disposed || stopped || page.isClosed()) return;
      try {
        if (event.frameId === mainFrameId) {
          try {
            options.policy.assertCurrentUrl(event.request.url);
            assertSecretNavigationAllowed(event.request.url, options.policy, options.secrets);
            options.credentials?.assertNavigation(event.request.url, event.request.postData);
            try { await options.allowRequest?.(event.request.url); }
            catch (error) { throw new Error(`Hosted private-network guard blocked navigation: ${String(error)}`); }
          } catch (error) {
            if (disposed || stopped || page.isClosed()) return;
            options.onDenied(error);
            try { await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); }
            catch (failure) { await stop(new Error(`Navigation guard could not block a denied request: ${String(failure)}`)); }
            return;
          }
        }
        if (disposed || stopped || page.isClosed()) return;
        await session.send('Fetch.continueRequest', { requestId: event.requestId });
      } catch (error) {
        if (disposed || page.isClosed()) return;
        if (active && !stopped && isExpiredPausedRequest(error)) return;
        await stop(new Error(`Navigation guard could not continue an authorized request: ${String(error)}`));
      }
    });
    // Subresources and background frames retain the existing hosted request guard.
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    active = true;
    return async () => { disposed = true; active = false; await session.detach().catch(() => {}); };
  } catch (error) { disposed = true; await session.detach().catch(() => {}); throw error; }
}
