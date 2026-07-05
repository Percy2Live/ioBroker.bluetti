# Repository checks

Issue #3 tracks the ioBroker-specific quality gates for this adapter.

## Local commands

Run the checks with Node 22 or newer. If GitHub returns HTTP 403 because the unauthenticated API rate limit is exhausted, export `OWN_GITHUB_TOKEN` before running the repository checker.


```sh
npm run build
npm run check
npm run lint
npm test
npm run test:integration
npm run test:repo
```

`npm run test:repo` executes:

```sh
npm exec --yes --package=@iobroker/repochecker@5.19.6 -c "repochecker https://github.com/Percy2Live/ioBroker.bluetti --local"
```

## Expected bootstrap findings

The repository checker validates release and ioBroker-repository state as well as files in this checkout. Until the first release is published and submitted upstream, these findings are expected and cannot be fixed only by editing repository files:

- the npm package `iobroker.bluetti` is not published yet
- release `0.0.1` is not tagged yet
- adapter `bluetti` is not present in the latest ioBroker repository yet
- unauthenticated/local checker runs may not retrieve GitHub Actions logs or may fail with HTTP 403 when the GitHub API rate limit is exhausted
- checker suggestions about GitHub releases, ioBroker repository membership, automerge, and dependency freshness are evaluated during release/dependency maintenance

All fixable package, io-package, workflow, README, i18n, Dependabot, build, lint, package-test, and integration-test findings should be treated as blockers.

## Known dev-dependency audit findings

`npm audit` reports 3 moderate dev-dependency findings that all share a single root cause and currently have no clean upstream fix. They are tracked here so release reviews do not repeat the investigation.

- **Advisory:** [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) — the esbuild dev server can receive requests from any website and read the response (development-only cross-origin request theft).
- **Dependency path:** `@iobroker/testing` → `@alcalzone/esbuild-register` → `esbuild@0.11.23` (the vulnerable range is esbuild `<=0.24.2`).
- **Why it is not fixed:**
  - `@iobroker/testing@5.2.2` is the latest published version and depends on `@alcalzone/esbuild-register@^2.5.1-1`.
  - `@alcalzone/esbuild-register@2.5.1-1` is the only version ever published; it is unmaintained and pins `esbuild@^0.11.5` (which installs `0.11.23`). There is no newer release to upgrade to.
  - `npm audit fix --force` would downgrade `@iobroker/testing` to `5.1.1`, a breaking change, so it is rejected.
- **Why the risk is acceptable here:** the advisory affects the esbuild **dev server** only. CI and local test runs never start a dev server, so the vulnerable code path is not exercised. `@alcalzone/esbuild-register` uses esbuild purely to transpile the test files.
- **Scope:** only the test-register path pulls in the vulnerable esbuild. The build toolchain (`@iobroker/adapter-dev`) already uses `esbuild@0.25.12`, which is not affected.
- **Upstream tracking:** when `@alcalzone/esbuild-register` publishes a release using esbuild `>=0.25` (or `@iobroker/testing` switches transpilers), bump `@iobroker/testing` and re-run `npm audit` to confirm the findings clear.
