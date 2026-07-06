# Security Audit — Dependency Review

**Last reviewed:** 2026-07-05 (before first public release)
**Scope:** `npm audit` findings for `iobroker.bluetti`.

## Summary

`npm audit` reported **6 vulnerabilities** (1 low, 4 moderate, 1 high). **All findings are in
dev/test dependency chains that are transitively pulled in by `@iobroker/testing`.**

> **No runtime dependencies are affected.** The only runtime dependency is
> `@iobroker/adapter-core`, which does not appear in any advisory path. Nothing in the
> `build/` output shipped to users is impacted.

This review was performed prior to the first public release of the adapter.

## Findings & remediation

| Package | Severity | Source (dev-only) | Advisory | Action |
| --- | --- | --- | --- | --- |
| `serialize-javascript` | **High** | `mocha` → `@iobroker/testing` | RCE / prototype-pollution style issue in `serialize-javascript` <7.0.7 | **Remediated** via npm `overrides` → `^7.0.7` |
| `diff` | Low | `mocha` → `@iobroker/testing` | ReDoS / DoS in `diff` 6.0.0–8.0.2 | **Remediated** via npm `overrides` → `^9.0.0` |
| `esbuild` | Moderate (×4 paths) | `@alcalzone/esbuild-register` → `@iobroker/testing` | Dev-server CSRF (`esbuild` ≤0.24.2) — enables any website to send requests to the esbuild dev server and read the response | **Accepted (dev-only)** — see rationale below |

## Remediation details — npm `overrides`

The following overrides were added to `package.json`. They force `mocha`'s transitive
dependencies onto patched versions:

```jsonc
"overrides": {
  "serialize-javascript": "^7.0.7",
  "diff": "^9.0.0"
}
```

### Compatibility notes

`mocha@11.7.6` declares `serialize-javascript@^6.0.2` and `diff@^7.0.0`, so these overrides are
semver-major bumps relative to what mocha requests. The overrides were reviewed against mocha's
actual API usage:

- **`serialize-javascript`** — used only in `mocha/lib/nodejs/buffered-worker-pool.js` as
  `serializeJavascript(opts, { … })`. The public `serialize(obj, options)` signature is unchanged
  between v6 and v7 (v7 was a security hardening release), so the override is API-compatible.
- **`diff`** — used only in `mocha/lib/reporters/base.js` via `diff.createPatch(...)` and
  `diff.diffWordsWithSpace(...)`. Both functions are retained across jsdiff v7→v9. These calls are
  exercised only when a failing assertion prints a diff.

> **Verification requirement:** The overrides must be confirmed by a full `npm install` followed by
> the test suite. See "Verification" below. If mocha's reporter or worker pool breaks with these
> versions, remove the offending override (particularly `diff@^9`, the larger jump for the
> lowest-severity issue) and re-classify that finding as accepted-dev-only.

## Accepted as dev-only

### `esbuild` (moderate, dev-server CSRF)

- **Path:** `@iobroker/testing@5.2.2` → `@alcalzone/esbuild-register@^2.5.1-1` → `esbuild@0.11.23`.
- **Why accepted:** No patched version is available for the `esbuild` range that
  `@alcalzone/esbuild-register` depends on without an upstream change to that package. An override
  to a fixed `esbuild` (>0.24.2) is incompatible with `@alcalzone/esbuild-register@2.5.1-1`'s API
  expectations and would break TypeScript test transpilation.
- **Risk assessment:** The advisory only affects esbuild's **development HTTP server** (`esbuild
  serve`). This adapter never runs the esbuild dev server — `esbuild-register` uses esbuild purely
  as an in-process transpiler for running TypeScript tests. The vulnerable code path is not
  reachable in this project. The dependency is `devDependencies` only and never ships in the
  published package (`files` in `package.json` publishes `build/` output only).
- **Follow-up:** Re-check on each `@iobroker/testing` release; adopt a fixed `esbuild` once
  `@alcalzone/esbuild-register` supports it.

## Actions explicitly NOT taken

- `npm audit fix --force` was **not** run: it downgrades `@iobroker/testing` from 5.2.2 to 5.1.1,
  which is a regression. `@iobroker/testing@5.2.2` is the latest release.
- No runtime dependency was modified.

## Verification

Run after `npm install`:

```bash
npm install     # applies the overrides
npm run check   # tsc --noEmit
npm run lint    # eslint
npm test        # mocha unit + package tests
npm run build   # build-adapter ts
npm audit       # expect: 4 moderate (esbuild) remaining; high + low resolved
```

Expected post-override `npm audit` result: the **high** (`serialize-javascript`) and **low**
(`diff`) findings are resolved; the **4 moderate** `esbuild` paths remain and are accepted as
documented above.
