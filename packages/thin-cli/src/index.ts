import { Command, CommanderError } from 'commander';
import { loginCommandFor } from '../../cli/src/commands/login.js';
import { logoutCommand } from '../../cli/src/commands/logout.js';
import { whoamiCommand } from '../../cli/src/commands/whoami.js';
import { runCommand } from './run.js';
import { version } from '../package.json';

// The thin CLI: your Zerocheck instance makes every decision; this drives your browser and keeps your test secrets.
// Usage errors exit 2, like every other failure that is not a verdict; commander prints them itself.
const program = new Command().name('zerocheck').version(version).description('Run Zerocheck browser tests on your own machine.').exitOverride();
program.command('login').description('Sign in and authorize this device for a project').action(loginCommandFor(version, [
  'Runs send the selected tests, and what the browser shows, to your Zerocheck instance. Test secret values stay on this machine.',
]));
program.command('logout').description('Revoke this device login and clear its local token').action(logoutCommand);
program.command('whoami').description('Show the project authorized by this account token').action(whoamiCommand);
program.command('run [paths...]').description('Run checks in your browser, with every decision made by your instance')
  .option('--env <name>', 'Environment from zerocheck.yaml')
  .option('--json <path>', 'Write the run record as JSON')
  .option('--fail-on-flaky', 'Exit 1 when a check passed only after a retry')
  .option('--headed', 'Show the browser')
  .option('--project-dir <dir>', 'Project folder', process.cwd())
  .action((paths: string[], options: { env?: string; json?: string; failOnFlaky?: boolean; headed?: boolean; projectDir: string }) => runCommand(paths, options));
program.parseAsync().catch((error: unknown) => {
  if (error instanceof CommanderError) { process.exitCode = error.exitCode === 0 ? 0 : 2; return; }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
