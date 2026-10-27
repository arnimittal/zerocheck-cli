import { hostname } from 'os';
import chalk from 'chalk';
import { apiRequest, isApiError } from '../api-client.js';
import { apiBase, saveConfig, accessToken } from '../config.js';

interface DeviceResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface PollApproved {
  status: 'approved';
  access_token: string;
  token_type: string;
  scope: string;
  project_id?: string;
}

interface PollPending {
  status: 'authorization_pending';
  interval: number;
}

type PollResponse = PollApproved | PollPending;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The CLI's sign-in, reporting the CLI's version and what its runs send. */
export function loginCommandFor(clientVersion: string, notice: readonly string[]): () => Promise<void> {
  return () => login(clientVersion, notice);
}

async function login(clientVersion: string, notice: readonly string[]): Promise<void> {
  const instance = apiBase();
  if (accessToken()) {
    console.log(chalk.yellow('Already logged in.') + ' Run `zerocheck logout` first to re-authenticate.');
    return;
  }

  const deviceName = hostname();
  console.log(chalk.dim(`Connecting to ${apiBase()}...`));

  let device: DeviceResponse;
  try {
    device = await apiRequest<DeviceResponse>('/v1/cli/auth/device', {
      body: { device_name: deviceName, client_version: clientVersion },
      authed: false,
    });
  } catch (err) {
    if (isApiError(err)) {
      console.error(chalk.red(`Login failed (${err.status}): ${err.message ?? err.error}`));
    } else {
      console.error(chalk.red('Could not reach Zerocheck:'), err);
    }
    process.exit(1);
  }

  console.log();
  console.log(chalk.bold('Open this URL in your browser:'));
  console.log('  ' + chalk.cyan(device.verification_uri_complete));
  console.log();
  console.log(chalk.bold('Confirm this code:') + '  ' + chalk.green.bold(device.user_code));
  console.log();
  console.log(chalk.dim(`Waiting for approval (expires in ${Math.floor(device.expires_in / 60)} min)...`));

  const deadline = Date.now() + device.expires_in * 1000;
  const intervalMs = device.interval * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    try {
      const poll = await apiRequest<PollResponse>('/v1/cli/auth/poll', {
        body: { device_code: device.device_code },
        authed: false,
      });
      if (poll.status === 'approved') {
        saveConfig({
          api_url: instance,
          access_token: poll.access_token,
          created_at: new Date().toISOString(),
          device_name: deviceName,
          project_id: poll.project_id,
        });
        console.log();
        console.log(chalk.green('✓ Logged in as ') + chalk.bold(deviceName));
        console.log();
        for (const line of notice) console.log(chalk.dim(line));
        return;
      }
    } catch (err) {
      if (isApiError(err)) {
        if (err.status === 410 || err.status === 403) {
          console.error();
          console.error(chalk.red(err.message ?? err.error));
          process.exit(1);
        }
      }
    }
  }

  console.error();
  console.error(chalk.red('Login timed out. Run `zerocheck login` to try again.'));
  process.exit(1);
}
