import YAML from 'yaml';
import { containsSecretValue } from './redaction.js';

/** Never rewrite executed bytes while keeping their revision. Reject unsafe literals before execution. */
export function assertNoSecretLiterals(checks: ReadonlyArray<{ yaml: string }>, secrets: readonly string[]): void {
  for (const check of checks) {
    if (containsSecretValue(check.yaml, secrets) || containsSecretValue(YAML.parse(check.yaml), secrets)) {
      throw new Error('A check contains a configured secret value. Replace the literal with a ${NAME} credential reference before running or saving it.');
    }
  }
}
