# Zerocheck

**Repeatable browser tests from your release checklist**

Zerocheck turns your team's manual release checklist into saved end-to-end browser tests. Start with the important user journeys, review the test definitions and browser results, and rerun the checks as your app changes.

This is the Zerocheck CLI. Use it to run your repository tests in a browser on your laptop or in CI.

**New to Zerocheck? [Request pilot access](https://tryzerocheck.com/demo/).** We provision a customer instance and help you configure your first handful of tests during hands-on onboarding.

**Already onboarded?** [Run your saved tests](#run-your-saved-tests), or open the instance URL supplied during onboarding to use the web app.

## How it works

Your Zerocheck instance makes every decision: it reads each test, chooses each browser action, checks each expected outcome and keeps the results. This CLI drives a Chromium browser on your machine for the instance and keeps your test secrets on your machine.

## Before you start

Test execution requires a Zerocheck account, a provisioned customer instance and a project in that instance. **There is no default public service.**

Have these ready:

- **Node.js 20.19 or newer.**
- **Your instance URL** and account access, supplied during onboarding.
- **Your project files:** `zerocheck.yaml` with the correct project, environment and app URL, plus at least one saved YAML test in its configured test directory. We set up these files with you during onboarding.
- **A running app** reachable from your machine, with the test accounts and credential variables your tests need.

## Run your saved tests

Run from the app repository containing the project files above. Replace the instance URL with the one you received during onboarding.

```bash
npm install --save-dev --save-exact zerocheck@0.2.1
npx playwright install chromium
export ZEROCHECK_API="https://your-instance.example.com"
npx zerocheck login
npx zerocheck run --json .zerocheck/latest-run.json
```

`playwright install chromium` downloads the browser that the CLI drives. `login` prints a URL and a code for you to approve in your browser; `whoami` shows the instance and project you are signed in to, and `logout` signs this machine out. In CI, set `ZEROCHECK_API` and a project token from Settings as `ZEROCHECK_TOKEN` instead of signing in.

`run` executes the saved tests in the configured test directory, using `default_environment` from `zerocheck.yaml`. Confirm that environment points to the app you intend to test. It prints each test's result and a results link; open it to inspect the steps, screenshots and recordings after signing in. `--json` also writes the run record to a file.

To run just one test, use its actual repository path:

```bash
npx zerocheck run zerocheck/tests/your-test.yaml
```

Options: `--env <name>` chooses another environment from `zerocheck.yaml`, `--headed` shows the browser, `--fail-on-flaky` fails a test that passed only after a retry, and `--project-dir <dir>` runs a project in another folder.

## Test secrets stay on your machine

Reference each secret in `zerocheck.yaml` as an environment variable and set that variable where the CLI runs:

```yaml
environments:
  dev:
    url: http://localhost:3000
    secrets:
      PASSWORD: ${APP_TEST_PASSWORD}
    login_steps:
      - Enter "{{credential:PASSWORD}}" into "Password"
```

The CLI sends the instance each secret's name, never its value, and types the value itself only where the test refers to it. A missing variable stops the run before it starts. A test or login step that writes out a configured secret value is refused before anything is sent: use a reference instead. Runs that use secrets are not recorded on video.

The instance receives the selected test files, the environment's settings without secret values, and what the browser shows while the tests run: page snapshots, screenshots, recordings and console messages.

## What a test looks like

Each repository test is a readable YAML file. Adapt this example to a route and outcome that exist in your app:

```yaml
version: zerocheck/v1
name: Release notes are available
blocks_merge: true
steps:
  - Navigate to /releases
  - Verify the Release notes heading is visible
```

To bring a test you made in the web app into your repository, use **Download YAML** and put that file in the configured test directory. This creates an independent copy.

## When a run needs attention

| Situation | Next step |
| --- | --- |
| No instance configured | Set `ZEROCHECK_API` to your customer instance before signing in. |
| No configuration or tests found | Add the project configuration and saved YAML tests. |
| Missing test secrets | Set the environment variables your configured environment references. |
| A test fails or cannot complete | Open the results link and inspect the failed step and its evidence. |
| Your instance is running as many runs as it allows | Try again shortly. |
| The run is not finished on your instance | Run `zerocheck run` again in the same folder: it finishes the earlier run first, then runs the tests you asked for. |

Press Ctrl-C once to cancel a run: the browser closes and your instance is told. A cancelled run never resumes. If the instance could not be told, or you pressed Ctrl-C again to stop waiting, the next `run` in the same folder tells it first. The CLI keeps this state in a `.zerocheck` folder in your project, which it excludes from Git.

Exit codes: **0** means every blocking test passed; **1** means a blocking test failed, or with `--fail-on-flaky` passed only after a retry; **2** means the run could not give a verdict: a setup or secret problem, a refused start, a cancellation, or a run that could not finish.

[Request pilot access](https://tryzerocheck.com/demo/) · [Developer resources](https://tryzerocheck.com/developers/) · [CLI guide](https://tryzerocheck.com/cli/) · [Web app guide](https://tryzerocheck.com/docs/web-app/) · [Results](https://tryzerocheck.com/docs/results/)
