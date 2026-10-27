import { readDOM } from './dom-reader.js';
import { ExecutionError } from '../engine/execution-error.js';
import type { ElementHandle } from 'playwright';
import type { ActionPlan } from './types.js';
import type { TargetPolicy } from '../policy/target-policy.js';
import { containsSecretText } from '../security/redaction.js';
import { frameOrigin } from './frame-policy.js';

/** Include encoded URL components without returning secret-bearing strings in errors. */
export function containsConfiguredSecret(value: string, secrets: readonly string[]): boolean {
  let decoded = value;
  for (let pass = 0; pass < 3; pass++) {
    if (containsSecretText(decoded, secrets)) return true;
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, ' '));
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
  return false;
}

/** Credentials never belong in navigation URLs, including on the app origin. */
export function assertSecretNavigationAllowed(url: string, policy: TargetPolicy, secrets: readonly string[]): void {
  if (containsConfiguredSecret(url, secrets)) {
    throw new ExecutionError('policy', `TargetPolicy blocked configured credentials in a navigation URL to ${new URL(url, policy.appOrigin).origin}. Use credential references in configured login inputs.`);
  }
}

/** Raw values are compared only in Node, never against secrets sent to page JavaScript. */
export async function assertCredentialBoundary(handle: ElementHandle<SVGElement | HTMLElement>, plan: ActionPlan, policy: TargetPolicy, secrets: readonly string[]): Promise<void> {
  const frame = await handle.ownerFrame();
  if (!frame) throw new ExecutionError('policy', 'TargetPolicy cannot establish the credential destination.');
  const origins: string[] = [];
  for (let ancestor: import('playwright').Frame | null = frame; ancestor; ancestor = ancestor.parentFrame()) origins.push(await frameOrigin(ancestor));
  const enteringSecret = ['fill', 'select', 'press'].includes(plan.action) && containsConfiguredSecret(plan.value ?? '', secrets);
  const assertOrigins = () => {
    for (const origin of origins) if (origin !== policy.appOrigin) throw new ExecutionError('policy', `TargetPolicy blocked configured credentials on ${origin}. Browser navigation permission does not grant credential access; credentials remain restricted to the app origin.`);
  };
  if (enteringSecret) assertOrigins();
  const inspected = await readDOM(handle, 'credentialBoundary');
  for (const destination of inspected.destinations) {
    policy.assertCurrentUrl(destination);
    assertSecretNavigationAllowed(destination, policy, secrets);
  }
  const usesSecret = enteringSecret || (['click', 'press', 'fill', 'select'].includes(plan.action) && inspected.values.some(value => containsConfiguredSecret(value, secrets)));
  if (!usesSecret) return;
  assertOrigins();
  for (const destination of inspected.destinations) {
    const origin = new URL(destination).origin;
    if (origin !== policy.appOrigin) throw new ExecutionError('policy', `TargetPolicy blocked submission of configured credentials to ${origin}. Browser navigation permission does not grant credential access; credentials remain restricted to the app origin.`);
  }
}
