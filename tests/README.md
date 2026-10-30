# Tests

The tests are an independent Vitest package. Install root dependencies first, then install the test package dependencies:

```sh
npm install
npm --prefix tests install
npm --prefix tests test -- --maxWorkers=1
```

Default discovery includes `**/*.test.js`, excluding `node_modules`, `.claude`, and `dist`; `.test.cjs` files are not discovered. `*.real.test.js` and `*.live.test.js` are excluded from the default run and only added back with `RUN_REAL=1`. Run with isolated temporary application state and no real provider credentials.

`RUN_REAL=1` also re-includes and runs those live files, which can use real credentials and make network calls. `RUN_E2E=1` enables the local-proxy E2E tests, which require a running proxy and appropriate credentials. `AG_CACHE_TEST=1` enables the Antigravity cache test and reads local account state. Consult each test for its prerequisites before opting in.

For example, from the repository root:

```sh
RUN_REAL=1 npx vitest run --config tests/vitest.config.js tests/unit/mimo-free.live.test.js
```

`unit/embeddingsCore.test.js` exercises the local embeddings handler. `unit/embeddings.cloud.test.js` tests a separate cloud worker absent from this repository; its cases are explicitly skipped when the worker is absent and are not local coverage. Run them only in a checkout containing the worker and its dependencies.

The SQLite-versus-lowdb benchmark was removed with the obsolete lowdb dependency. The JSON files and `known-fails.txt` in `__baseline__/` are historical triage artifacts, not a current full-suite result or an allowance for failures. Investigate all current assertion and collection failures rather than accepting an inherited count.
