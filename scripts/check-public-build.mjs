// Check the thin CLI's build. It ships in both the private repository and the CLI's public source repository
// (scripts/thin-cli-public-source.mjs), so it holds no engine strings of its own.
//
//   node scripts/check-public-build.mjs [--bundle-sha256 <hex>]
//       the built bundle names only the modules packages/thin-cli/public-modules.json lists, names enough of them to
//       show what it holds (esbuild's module comments, so an unminified build), and carries no source map; with a
//       digest, it must be exactly those bytes
//   node scripts/check-public-build.mjs --tarball <file.tgz> --contents-sha256 <hex>
//       the packed package holds exactly the verified files: the same paths with the same bytes, whichever npm packed it
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = join(root, 'packages/thin-cli');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** One digest for a packed package's contents: each file's path and SHA-256, sorted. Tar and gzip details do not count. */
export function contentsDigest(tarball) {
  const scratch = mkdtempSync(join(tmpdir(), 'zerocheck-contents-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', scratch]);
    const lines = [];
    const walk = directory => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path); else lines.push(`${relative(scratch, path).split(sep).join('/')} ${sha256(readFileSync(path))}`);
      }
    };
    walk(scratch);
    return sha256(`${lines.sort().join('\n')}\n`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** The built bundle's checks; returns its SHA-256. */
export function checkBundle() {
  const { modules } = JSON.parse(readFileSync(join(pkg, 'public-modules.json'), 'utf8'));
  const bundlePath = join(pkg, 'dist/index.js');
  if (!existsSync(bundlePath)) throw new Error('Build first.');
  const bundle = readFileSync(bundlePath), text = bundle.toString('utf8');
  const named = [...text.matchAll(/^\/\/ (\S+\.(?:[cm]?[jt]s|json))$/gm)].map(([, path]) => relative(root, resolve(pkg, path)));
  const foreign = new Set(named.filter(path => !path.startsWith(`packages${sep}thin-cli${sep}`)));
  const unlisted = [...foreign].filter(path => !modules.includes(path));
  if (unlisted.length) throw new Error(`The bundle holds modules public-modules.json does not list:\n${unlisted.map(path => `- ${path}`).join('\n')}`);
  const core = ['src/agent/operator-host.ts', 'src/agent/page-operator.ts', 'src/executor/executor.ts'];
  if (core.some(path => !foreign.has(path)) || foreign.size < modules.length * 0.9) throw new Error(`The bundle names ${foreign.size} of the ${modules.length} listed modules: build it unminified, from packages/thin-cli.`);
  if (/sourceMappingURL=|"sourcesContent"\s*:/.test(text) || existsSync(`${bundlePath}.map`)) throw new Error('The bundle carries a source map.');
  return { digest: sha256(bundle), named: foreign.size };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = name => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
  try {
    const tarball = arg('--tarball');
    if (tarball) {
      const expected = arg('--contents-sha256'), actual = contentsDigest(resolve(tarball));
      if (!expected) throw new Error('Give --contents-sha256 with --tarball.');
      if (actual !== expected) throw new Error(`The package's contents digest is ${actual}, not the verified ${expected}.`);
      console.log(`The package holds exactly the verified files. Contents SHA-256 ${actual}`);
    } else {
      const { digest, named } = checkBundle(), expected = arg('--bundle-sha256');
      if (expected && expected !== digest) throw new Error(`The bundle's SHA-256 is ${digest}, not the verified ${expected}.`);
      console.log(`The bundle holds ${named} listed modules and no source map. SHA-256 ${digest}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
