#!/usr/bin/env node
// `npm run dev`: the whole app -- UI and API -- on http://localhost:3000.
//
// Runs two processes and stops both when either exits (or on Ctrl+C):
//   - the Angular dev server (`ng serve`) on port 3000, with live reload and
//     hot module replacement for everything in app/ and shared/;
//   - the Express API under `tsx watch` on port 3001 (DEV_API_PORT),
//     restarting on every change to server/ or shared/.
// The dev server proxies /api and the /signal WebSocket to the API
// (app/proxy.conf.json), so the browser only ever talks to port 3000.
//
// `npm run dev:server` alone runs the API on port 3000 serving the last
// `npm run build:web` output, exactly like production.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WEB_PORT = '3000';
// Must match the proxy target in app/proxy.conf.json.
const API_PORT = '3001';

// The CLIs' own entry points, run with this Node: no npx/shell wrapper in
// between, so stopping this script really stops the dev server and the API.
const cli = (pkg, bin) => path.join(root, 'node_modules', pkg, bin);
const run = (entry, args, env = {}) =>
  spawn(process.execPath, [entry, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

const children = [
  run(cli('tsx', 'dist/cli.mjs'), ['watch', 'server/server.ts'], { PORT: API_PORT }),
  run(cli('@angular/cli', 'bin/ng.js'), ['serve', '--port', WEB_PORT]),
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
