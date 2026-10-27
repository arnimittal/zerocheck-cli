import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'fs';

const CONFIG_DIR = join(homedir(), '.zerocheck');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function normalizeInstanceUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('ZEROCHECK_API must be your complete Zerocheck instance URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS Zerocheck instance origin without credentials, path, query or fragment. HTTP is allowed for localhost development.');
  }
  return url.origin;
}

/** No implicit public service: a destination must be chosen by the instance owner. */
export function apiBase(): string {
  const explicit = process.env.ZEROCHECK_API?.trim();
  if (process.env.ZEROCHECK_TOKEN?.trim() && !explicit) throw new Error('Set ZEROCHECK_API explicitly alongside ZEROCHECK_TOKEN for this customer instance.');
  const raw = explicit || loadConfig().api_url;
  if (!raw) throw new Error('Set ZEROCHECK_API to your Zerocheck instance URL before signing in or connecting.');
  return normalizeInstanceUrl(raw);
}

export interface StoredConfig {
  access_token?: string;
  created_at?: string;
  device_name?: string;
  project_id?: string;
  api_url?: string;
}

/** CI uses the same account token as interactive login. */
export function accessToken(): string | undefined {
  const environmentToken = process.env.ZEROCHECK_TOKEN?.trim();
  if (environmentToken) { apiBase(); return environmentToken; }
  const stored = loadConfig();
  if (!stored.access_token) return undefined;
  if (!stored.api_url) throw new Error('This device token has no bound instance. Run `zerocheck logout`, then set ZEROCHECK_API and sign in again.');
  if (normalizeInstanceUrl(stored.api_url) !== apiBase()) throw new Error('This device token belongs to another Zerocheck instance. Unset ZEROCHECK_API to use its saved instance, or log out and sign in to the intended instance.');
  return stored.access_token;
}

export function requireToken(): string {
  const token = accessToken();
  if (!token) throw new Error('Sign in with `zerocheck login`, or set ZEROCHECK_TOKEN to a project token from Settings.');
  return token;
}

export function loadConfig(): StoredConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as StoredConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: StoredConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

export function clearConfig(): void {
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
}

export function configPath(): string {
  return CONFIG_FILE;
}
