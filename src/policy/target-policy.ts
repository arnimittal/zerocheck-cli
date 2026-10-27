import type { RunTrigger } from '../../shared/contracts.js';
import { isIP } from 'node:net';
import { ExecutionError } from '../engine/execution-error.js';
import { validateAllowedOrigins } from '../../shared/origins.js';
export type ExecutionMode = RunTrigger;
export interface TargetPolicyConfig { targetUrl: string; allowedOrigins?: string[] }

export interface TargetDecision {
  allowed: boolean;
  url: string;
  reason?: string;
}

export class TargetPolicy {
  private readonly allowedOrigins: Set<string> | undefined;
  private readonly appBase: string;
  readonly appOrigin: string;

  constructor(config: TargetPolicyConfig) {
    const base = new URL(config.targetUrl);
    this.appOrigin = base.origin;
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    this.appBase = base.href;
    const restrictions = validateAllowedOrigins(config.allowedOrigins);
    this.allowedOrigins = restrictions.length ? new Set([this.appOrigin, ...restrictions]) : undefined;
  }

  resolve(rawTarget: string, currentUrl: string): TargetDecision {
    let url: URL;
    try {
      const base = this.baseFor(currentUrl);
      url = new URL(rawTarget, base);
    } catch {
      return { allowed: false, url: rawTarget, reason: 'Invalid navigation target' };
    }
    return this.evaluateUrl(url);
  }

  evaluate(rawUrl: string): TargetDecision {
    try {
      return this.evaluateUrl(new URL(rawUrl));
    } catch {
      return { allowed: false, url: rawUrl, reason: 'Invalid URL' };
    }
  }

  assertAllowed(rawTarget: string, currentUrl: string): string {
    const decision = this.resolve(rawTarget, currentUrl);
    if (!decision.allowed) {
      throw new ExecutionError('policy', `TargetPolicy blocked navigation: ${decision.reason}`);
    }
    return decision.url;
  }

  assertCurrentUrl(rawUrl: string): void {
    const decision = this.evaluate(rawUrl);
    if (!decision.allowed) {
      throw new ExecutionError('policy', `TargetPolicy blocked origin: ${decision.reason}`);
    }
  }

  private baseFor(_currentUrl: string): string { return this.appBase; }

  private evaluateUrl(url: URL): TargetDecision {
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { allowed: false, url: url.href, reason: 'Only HTTP(S) URLs are allowed' };
    }
    if (url.username || url.password) return { allowed: false, url: url.href, reason: 'URLs with embedded credentials are not permitted.' };
    if (!this.allowedOrigins || this.allowedOrigins.has(url.origin)) {
      return { allowed: true, url: url.href };
    }
    return { allowed: false, url: url.href, reason: `${url.origin} is outside the configured browser restriction. Update or remove allowed_origins in the environment settings. Credential and hosted private-network protections still apply.` };
  }
}

export function createTargetPolicy(config: TargetPolicyConfig): TargetPolicy {
  return new TargetPolicy(config);
}

export function isPrivateOrInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (host === 'metadata.google.internal') return true;
  if (host === '169.254.169.254') return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (isIP(host) === 6) {
    // Prefixes apply only to literals, never names such as fcm.googleapis.com.
    const address = host.split('%')[0];
    const tail = address.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    const ipv6 = tail ? address.slice(0, -tail.length) + parseIpv4(tail)!.reduce((parts, value, index, values) => index % 2 ? parts : [...parts, ((value << 8) | values[index + 1]).toString(16)], [] as string[]).join(':') : address;
    const [left, right = ''] = ipv6.split('::');
    const before = left ? left.split(':') : [], after = right ? right.split(':') : [];
    const words = [...before, ...Array(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after].map(word => parseInt(word, 16));
    if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) return isPrivateOrInternalHost(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    if (words.every(word => word === 0) || words.slice(0, 7).every(word => word === 0) && words[7] === 1) return true;
    if ((words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80) return true;
  }

  return false;
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}
