import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundles the Express server (server/server.ts plus server/lib) into one
// file the runtime image runs: dist/server/server.js. Paths are resolved from this file, so the
// script works from any working directory.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'server', 'server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: path.join(root, 'dist', 'server', 'server.js'),
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});
