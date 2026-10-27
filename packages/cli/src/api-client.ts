import { apiBase, accessToken } from './config.js';

export class ApiError extends Error {
  constructor(public status: number, public error: string, message?: string) {
    super(message ?? error);
    this.name = 'ApiError';
  }
}
export function isApiError(error: unknown): error is ApiError { return error instanceof ApiError; }

export async function apiRequest<T>(path: string, init: {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; body?: unknown;
  raw?: Uint8Array; authed?: boolean; signal?: AbortSignal;
} = {}): Promise<T> {
  const token = init.authed === false ? undefined : accessToken();
  const response = await fetch(apiBase() + path, {
    // Even an unauthenticated request can carry device codes or test credentials.
    redirect: 'error',
    method: init.method ?? 'POST',
    headers: {
      'content-type': init.raw ? 'application/octet-stream' : 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.raw ? Buffer.from(init.raw) : init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(init.signal ? [init.signal] : [])]),
  });
  const raw = await response.text();
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  if (!response.ok) {
    const payload = data as { error?: string; message?: string } | undefined;
    throw new ApiError(response.status, payload?.error ?? 'http_error', payload?.message ?? `Zerocheck returned HTTP ${response.status}.`);
  }
  return data as T;
}
