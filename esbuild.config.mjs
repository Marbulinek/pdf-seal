import { build } from 'esbuild';

await build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: 'dist/server.js',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});
