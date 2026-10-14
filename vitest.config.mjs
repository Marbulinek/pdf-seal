import { defineConfig } from 'vitest/config';

// The Node-side unit tests, as three Vitest projects (the Angular app's
// specs run separately, through `ng test` in app/):
//   server    -> server/test   (the Express server's lib/ and the demo sample)
//   shared    -> shared/test   (isomorphic modules used by server and app)
//   extension -> extension/test (the browser extension's pure helpers)
// Run one with `npx vitest run --project server`.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'server', include: ['server/test/**/*.test.ts'] } },
      { test: { name: 'shared', include: ['shared/test/**/*.test.ts'] } },
      { test: { name: 'extension', include: ['extension/test/**/*.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['server/lib/**', 'shared/*.ts'],
      thresholds: {
        statements: 90,
        branches: 75,
        functions: 90,
        lines: 90,
      },
    },
  },
});
