#!/usr/bin/env node
// `npm run dev`: one command for local development on http://localhost:3000.
//
// Runs the Angular CLI in watch mode (rebuilding dist/web/browser on every
// change to src/ or public/) next to the Express server under `tsx watch`
// (restarting on every change to server.ts or lib/). The server serves the
// freshly built UI, exactly like production -- reload the page to pick up a
// UI rebuild. For hot module replacement instead, run `npm run dev:api` and
// `npm run dev:web` in two terminals and open http://localhost:4200 (the
// Angular dev server proxies /api and /signal to the API, see proxy.conf.json).
import { spawn } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const children = [
  spawn(npx, ['ng', 'build', '--watch', '--configuration', 'development'], { stdio: 'inherit' }),
  spawn(npx, ['tsx', 'watch', 'server.ts'], { stdio: 'inherit' }),
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
