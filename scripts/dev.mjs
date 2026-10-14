#!/usr/bin/env node
// `npm run dev`: one command for local development on http://localhost:3000.
//
// Runs the Angular CLI in watch mode in app/ (rebuilding dist/app/browser on
// every change to app/src or app/public) next to the Express server under
// `tsx watch` (restarting on every change to server/ or shared/). The server serves the
// freshly built UI, exactly like production -- reload the page to pick up a
// UI rebuild. For hot module replacement instead, run `npm run dev:server`
// and `npm run dev:web` in two terminals and open http://localhost:4200 (the
// Angular dev server proxies /api and /signal to the API, see app/proxy.conf.json).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const children = [
  spawn(npx, ['ng', 'build', '--watch', '--configuration', 'development'], { cwd: path.join(root, 'app'), stdio: 'inherit' }),
  spawn(npx, ['tsx', 'watch', 'server/server.ts'], { cwd: root, stdio: 'inherit' }),
];

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exit(code);
}

for (const child of children) child.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
