# Zerocheck

Zerocheck is an AI QA engineer that tests your app end to end. Verify critical flows and find bugs with a prompt.

This is the Zerocheck CLI.

```yaml
# zerocheck/tests/discount-code.yaml
version: zerocheck/v1
name: Discount code reaches confirmation
blocks_merge: true
steps:
  - Navigate to /cart
  - Enter "SPRING20" into "Discount code"
  - Click "Apply"
  - Verify text "Discount applied" is visible
  - Enter "4242424242424242" into "Card number"
  - Click "Place order"
  - Verify text "Order confirmed" is visible
```

The CLI runs YAML tests like this one in a Chromium browser on your machine or a CI runner. Your dedicated Zerocheck instance reads each test, makes the model calls and keeps the results. The CLI drives the browser for it and keeps your test secret values on your machine.

## Quick start

Zerocheck needs a dedicated instance, which we set up with you during [hands-on onboarding](https://tryzerocheck.com/onboarding/). There is no default public service. You'll also need Node.js 20.19 or newer, `zerocheck.yaml` and at least one saved test. We set those up with you too.

```bash
npm install --save-dev --save-exact zerocheck
npx playwright install chromium
export ZEROCHECK_API="https://your-instance.example.com"
npx zerocheck login
npx zerocheck run
```

`login` prints a URL and a code for you to approve in your browser. `run` executes the tests in your configured test directory and prints each result with a link to the run. Open it to see the steps, screenshots and any recording. To run one test, use its path: `npx zerocheck run zerocheck/tests/discount-code.yaml`.

In CI, set `ZEROCHECK_API` and a project token from Settings as `ZEROCHECK_TOKEN` instead of signing in.

## Commands

| Command | What it does |
| --- | --- |
| `login` | Sign in and authorize this device for a project |
| `logout` | Revoke this device login and clear its local token |
| `whoami` | Show the instance and project you're signed in to |
| `run [paths...]` | Run tests in your browser |

`run` options: `--env <name>`, `--json <path>`, `--fail-on-flaky`, `--headed` and `--project-dir <dir>`.

Exit codes: **0** every blocking test passed. **1** a blocking test failed, or with `--fail-on-flaky` passed only after a retry. **2** the run gave no verdict.

## Test secrets

Reference each secret in `zerocheck.yaml` as an environment variable, and set that variable where the CLI runs:

```yaml
environments:
  dev:
    url: http://localhost:3000
    secrets:
      PASSWORD: ${APP_TEST_PASSWORD}
    login_steps:
      - Enter "{{credential:PASSWORD}}" into "Password"
```

Your instance receives each secret's name, never its value. It does receive the selected test files and what the browser shows while tests run, so the CLI needs network access and doesn't run offline.

## Web app or CLI

Tests you create in the web app run there in a hosted browser, with nothing to install. To bring one into your repository, use **Download YAML** and put the file in your test directory. That creates an independent copy, and edits don't sync.

## Documentation

[CLI guide](https://tryzerocheck.com/docs/cli/) · [Web app](https://tryzerocheck.com/docs/web-app/) · [Run in CI](https://tryzerocheck.com/docs/github-actions/) · [Credentials and data](https://tryzerocheck.com/docs/security/) · [Pricing](https://tryzerocheck.com/pricing/)
