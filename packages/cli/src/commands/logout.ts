import chalk from 'chalk';
import { apiRequest, isApiError } from '../api-client.js';
import { loadConfig, clearConfig } from '../config.js';

export async function logoutCommand(): Promise<void> {
  if (process.env.ZEROCHECK_TOKEN) throw new Error('ZEROCHECK_TOKEN is set. Unset it to revoke this device login, or revoke that token in project Settings.');
  const cfg = loadConfig();
  if (!cfg.access_token) {
    console.log(chalk.dim('Not logged in.'));
    return;
  }

  try {
    await apiRequest('/v1/cli/auth/revoke', { body: {} });
  } catch (err) {
    if (!(isApiError(err) && err.status === 401)) {
      console.warn(chalk.yellow('The device token could not be revoked on its instance. Clearing only the local login; revoke the token in that instance’s Settings if needed.'));
    }
  }

  clearConfig();
  console.log(chalk.green('✓ Logged out.'));
}
