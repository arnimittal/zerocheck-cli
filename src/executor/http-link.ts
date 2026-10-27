import type { CancelMessage, NextAnswer, NextMessage } from '../agent/operator-protocol.js';
import { InstanceRefusal, type InstanceLink } from './executor.js';

export interface HttpLinkOptions {
  /** The instance, for example https://acme.tryzerocheck.com */
  base: string; token: string; runId: string;
  /** Each request ends well before Cloudflare's 100 s proxy limit; the instance's long poll is shorter still. */
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

/** The thin CLI's link to its instance over HTTPS, under the run's CLI project token. */
export function httpLink(options: HttpLinkOptions): InstanceLink {
  const send = options.fetch ?? fetch;
  const post = async (path: string, message: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }> => {
    const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? 60_000);
    const response = await send(`${options.base.replace(/\/+$/, '')}/v1/cli/runs/${encodeURIComponent(options.runId)}/operator/${path}`, {
      method: 'POST', redirect: 'error', body: JSON.stringify(message), headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
    // Only a refusal of this CLI or run is final; anything else (a server error, a proxy, a rejected body) is retried
    // until the CLI gives up.
    if (![200, 401, 403, 404, 409].includes(response.status)) throw new Error(`The instance answered HTTP ${response.status}.`);
    return { status: response.status, body };
  };
  const refusal = (status: number, body: unknown) => new InstanceRefusal(`The instance refused this CLI (HTTP ${status}): ${String((body as { message?: unknown })?.message ?? body).slice(0, 300)}`, status);
  return {
    async next(message: NextMessage, signal: AbortSignal): Promise<NextAnswer> {
      const { status, body } = await post('next', message, signal);
      if (status !== 200) throw refusal(status, body);
      return body as NextAnswer;
    },
    async upload(name: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
      const response = await send(`${options.base.replace(/\/+$/, '')}/v1/cli/runs/${encodeURIComponent(options.runId)}/artifacts?path=${encodeURIComponent(name)}`, {
        method: 'POST', redirect: 'error', body: Buffer.from(bytes), headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${options.token}` },
        // A recording is larger than a message: it gets two minutes at least, unless its budget or Ctrl-C ends it first.
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(options.requestTimeoutMs ?? 60_000, 120_000))]),
      });
      const text = await response.text();
      if (response.status === 200) return;
      let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
      // Refused for good (no access, no such run, other bytes under this name, too large); anything else is retried.
      if ([400, 401, 403, 404, 409, 413].includes(response.status)) throw refusal(response.status, body);
      throw new Error(`The instance answered HTTP ${response.status}.`);
    },
    async cancel(message: CancelMessage): Promise<void> {
      const { status, body } = await post('cancel', message);
      // Idempotent: the instance acknowledges a run that has already ended too.
      if (status !== 200 || (body as { acknowledged?: unknown })?.acknowledged !== true) throw refusal(status, body);
    },
  };
}
