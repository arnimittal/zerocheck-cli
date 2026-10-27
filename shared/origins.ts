/** Configuration grants are exact HTTP(S) origins, never URL patterns or destinations. */
export function validateAllowedOrigins(value: unknown, label = 'allowed_origins'): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of exact HTTP(S) origins.`);
  return [...new Set(value.map(raw => {
    const invalid = () => new Error(`${label} must contain exact HTTP(S) origins, for example https://checkout.example.com, without wildcards, credentials, paths, queries or fragments.`);
    if (typeof raw !== 'string' || raw.trim() !== raw || /[*@\\\s]/.test(raw)) throw invalid();
    let url: URL;
    try { url = new URL(raw); } catch { throw invalid(); }
    // URL() normalizes empty queries, dot paths and credentials; reject those in the authored value too.
    if (!/^https?:\/\/[^/?#]+\/?$/i.test(raw) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid();
    return url.origin;
  }))];
}

export function validateSecretOrigins(value: unknown, configuredSecrets: Record<string, string>, appUrl: string, allowedOrigins: readonly string[], label = 'secret_origins'): Record<string, string[]> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must map configured credential names to exact origins.`);
  const appOrigin = new URL(appUrl).origin;
  const allowed = new Set([appOrigin, ...allowedOrigins]);
  const entries: Array<[string, string[]]> = [];
  for (const [name, destinations] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(configuredSecrets, name)) throw new Error(`${label}.${name} must name a configured credential.`);
    if (!Array.isArray(destinations)) throw new Error(`${label}.${name} must be a list of exact HTTP(S) origins.`);
    const origins = validateAllowedOrigins(destinations, `${label}.${name}`);
    if (allowedOrigins.length && origins.some(origin => !allowed.has(origin))) throw new Error(`${label}.${name} destinations must also appear in the configured allowed_origins restriction. The app origin is already included.`);
    entries.push([name, origins.filter(origin => origin !== appOrigin)]);
  }
  return Object.fromEntries(entries);
}
