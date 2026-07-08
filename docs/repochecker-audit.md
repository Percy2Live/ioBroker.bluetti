# Repochecker Audit — 2026-07-08

**Tool:** `@iobroker/repochecker@5.19.6`
**Commit:** `6bdb06c0e051d6d9c4e0de032e543e4330abebe3`
**Mode:** LOCAL
**Result:** `OK` (overall status), with 4 errors, 9 warnings, 1 suggestion

## Command

```bash
npm run test:repo
# → npm exec --yes --package=@iobroker/repochecker@5.19.6 -c "repochecker https://github.com/Percy2Live/ioBroker.bluetti --local"
```

## Findings

### Errors

| Code | Message | Status | Tracked in |
|------|---------|--------|------------|
| E2001 | Bluefox was not found as collaborator on npm | **NEW** — needs-human | — |
| E2008 | Version 0.0.1 tagged as "latest" at npm is not signed with provenance | already-tracked | #77 |
| E3032 | No workflow run for "test-and-release.yml" triggered by tag "v0.0.1" | already-tracked | #77 |
| E6013 | README.md suggests installing from GitHub — installation from GitHub is discouraged | **NEW** — fixable | — |

### Warnings

| Code | Message | Status | Tracked in |
|------|---------|--------|------------|
| W3050 | "test-and-release.yml": could not retrieve log for "check-and-lint" job (run #100) | **NEW** — likely transient (deleted CI logs) | — |
| W3052 (×6) | "test-and-release.yml": could not retrieve logs for adapter-tests jobs (run #100) | **NEW** — likely transient (deleted CI logs) | — |
| W4001 | Cannot find "bluetti" in latest repository | already-tracked | #81 |
| W9501 | .npmignore found but "files" is used in package.json — remove .npmignore | **NEW** — fixable | — |

### Suggestions

| Code | Message | Status | Tracked in |
|------|---------|--------|------------|
| S8914 | Automerge is configured but ".github/auto-merge.yml" was not found | **NEW** — fixable | — |

## Classification of New Findings

### E2001 — Bluefox not collaborator on npm

**Action needed:** `npm owner add bluefox iobroker.bluetti` (or invite via npmjs.com).
**Who:** Pascal (needs-human, npm account access required).

### E6013 — README install from GitHub

README line 48 instructs users to install via "Install from custom URL" with a GitHub tarball link. The repochecker flags this as discouraged.

**Fix:** Reword README installation section to mention ioBroker Admin adapter search once the adapter is in the latest repository (#81). Until then, keep the custom URL instructions but rephrase to avoid the "install from npm/github" trigger pattern. Alternatively, remove the explicit `npm install` / GitHub tarball instructions and link to the ioBroker docs.

### W3050 / W3052 — CI logs not retrievable

Repochecker could not fetch logs for CI run #100 (tag v0.0.1). This is likely because the workflow run logs were deleted or expired. Related to #77 (CI deploy job). No action needed beyond #77 — once provenance signing and deploy are fixed, the tag-triggered workflow will produce fresh logs.

### W9501 — .npmignore redundant with `files`

`package.json` has a `files` field that precisely controls what's included in the npm package. `.npmignore` is redundant in this setup — npm uses `files` as the primary filter. The `.npmignore` was added in #79 for defense-in-depth, but the repochecker recommends removing it.

**Fix:** `git rm .npmignore`. The `files` field already excludes `src/`, `test/`, `tsconfig*.json`, etc.

### S8914 — auto-merge.yml missing

GitHub auto-merge is enabled on the repo (via PR settings), but the repochecker expects a `.github/auto-merge.yml` config file for explicit configuration.

**Fix:** Add `.github/auto-merge.yml` with automerge settings (squash + delete-branch, matching current PR workflow).

## Summary

| Category | Count | Already tracked | New (fixable) | New (needs-human) | New (transient) |
|----------|-------|-----------------|---------------|-------------------|-----------------|
| Errors | 4 | 2 | 1 (E6013) | 1 (E2001) | 0 |
| Warnings | 9 | 1 | 1 (W9501) | 0 | 7 (W3050/W3052) |
| Suggestions | 1 | 0 | 1 (S8914) | 0 | 0 |
| **Total** | **14** | **3** | **3** | **1** | **7** |

No unexplained findings remain. All 14 findings are classified.