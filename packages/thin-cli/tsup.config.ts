// The thin CLI ships only the browser side, the modules public-modules.json lists; scripts/verify-thin-cli-package.mjs
// builds, packs and checks the package against that list. Dependencies stay external and come from the public registry.
// A plain object: tsup itself is installed in packages/cli, not here.
export default {
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  minify: false,
  splitting: false,
  shims: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
};
