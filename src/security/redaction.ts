const REDACTION = '[redacted]';
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_ASSIGNMENT_RE = /\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|bearer token|refresh[_ -]?token|token|secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/\-=]{6,}["']?/gi;
const TOKEN_VALUE_RE = /\b(?:sk|pk|gh[pousr]|xox[baprs]|ya29|eyJ|tok|key)[A-Za-z0-9._-]{8,}\b/g;
const STRUCTURED_ID_RE = /\b(?:cus|acct|user|session|tok|pi|ch)_[A-Za-z0-9]{8,}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;
const PHONE_RE = /\b(?:\+?\d[\d(). -]{8,}\d)\b/g;
const AUTH_PARAMETER_RE = /([?&#](?:code|state|nonce|access_token|id_token|refresh_token|client_secret|session_token|authorization|token)=)[^&#\s"'<>\\]*/gi;

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of normalizedSecrets(secrets)) {
    out = out.split(secret).join(REDACTION);
  }
  return out.replace(AUTH_PARAMETER_RE, '$1[redacted]');
}

export function redactTerminalEvidenceText(text: string, secrets: readonly string[]): string {
  return redactText(text, secrets)
    .replace(EMAIL_RE, '[redacted_email]')
    .replace(TOKEN_ASSIGNMENT_RE, (_match, label: string) => `${label}: ${REDACTION}`)
    .replace(TOKEN_VALUE_RE, '[redacted_token]')
    .replace(STRUCTURED_ID_RE, '[redacted_id]')
    .replace(SSN_RE, REDACTION)
    .replace(CARD_RE, REDACTION)
    .replace(PHONE_RE, REDACTION);
}

export function containsSecretText(text: string | null | undefined, secrets: readonly string[]): boolean {
  if (!text) return false;
  return normalizedSecrets(secrets).some((secret) => text.includes(secret));
}

export function containsSecretValue(value: unknown, secrets: readonly string[]): boolean {
  const normalized = normalizedSecrets(secrets);
  if (normalized.length === 0) return false;
  return containsSecretValueInner(value, normalized, new Set<object>());
}

export function redactConsoleLogs<T extends { text: string; sourceUrl?: string | null }>(
  logs: T[],
  secrets: readonly string[],
): T[] {
  return logs.map((log) => ({
    ...log,
    text: redactText(log.text, secrets),
    sourceUrl: log.sourceUrl == null ? log.sourceUrl : redactText(log.sourceUrl, secrets),
  }));
}

function normalizedSecrets(secrets: readonly string[]): string[] {
  return redactionValues(secrets);
}

/** Error serializers, form encoders and DOM whitespace can render the same data differently. */
export function redactionValues(secrets: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const secret of secrets.filter(Boolean)) {
    const normalized = [secret, secret.replace(/\r\n?/g, '\n'), secret.replace(/\r?\n/g, '\r\n'), secret.replace(/[\r\n]/g, ''), secret.replace(/\s+/g, ' ')];
    for (const value of normalized.flatMap(value => [value, value.trim()])) {
      if (!value) continue;
      variants.add(value);
      const escaped = JSON.stringify(value).slice(1, -1);
      variants.add(escaped); variants.add(JSON.stringify(escaped).slice(1, -1));
      try { const encoded = encodeURIComponent(value); variants.add(encoded); variants.add(encoded.replace(/%20/g, '+')); } catch { /* Unpaired surrogate cannot be URL encoded. */ }
    }
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function containsSecretValueInner(value: unknown, secrets: readonly string[], seen: Set<object>): boolean {
  if (typeof value === 'string') {
    return secrets.some((secret) => value.includes(secret));
  }
  if (value == null || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((child) => containsSecretValueInner(child, secrets, seen));
  }
  return Object.values(value as Record<string, unknown>).some((child) =>
    containsSecretValueInner(child, secrets, seen),
  );
}
