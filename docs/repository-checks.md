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
