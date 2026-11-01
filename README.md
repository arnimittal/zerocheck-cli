# Zerocheck CLI

Zerocheck is an AI QA engineer that tests your app end to end. Verify critical flows and find bugs with a prompt.

This repository is the source of the [`zerocheck`](https://www.npmjs.com/package/zerocheck) command-line interface,
from which each version is built and published to npm with provenance. Usage and setup are in
[packages/thin-cli/README.md](packages/thin-cli/README.md).

The CLI drives a Chromium browser on your machine or a CI runner, and keeps your test secret values there. Your
dedicated Zerocheck instance makes the decisions and keeps the results. The instance is not part of this repository.

This repository holds the CLI's own code (`packages/thin-cli`) and the browser-side modules it bundles, listed in
`packages/thin-cli/public-modules.json` and kept at the paths they have where Zerocheck develops them.

## Build

```bash
npm ci --ignore-scripts
npm run build
npm run check
```

`build` bundles `packages/thin-cli/dist/index.js` with esbuild; types are checked where Zerocheck develops the CLI.
`check` confirms the bundle holds only the listed modules and no source map. A release publishes only a package whose
bundle and contents match the digests recorded when that version was verified.

Usage and setup: [packages/thin-cli/README.md](packages/thin-cli/README.md).
