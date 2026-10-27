# zerocheck CLI

The source of the [`zerocheck`](https://www.npmjs.com/package/zerocheck) command-line interface, from which each version
is built and published to npm with provenance.

The CLI runs your Zerocheck tests in a Chromium browser on your machine. Your Zerocheck instance makes every decision:
it reads each test, chooses each browser action, checks each expected outcome and keeps the results. The CLI drives the
browser for it and keeps your test secrets on your machine. The instance is not part of this repository.

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
