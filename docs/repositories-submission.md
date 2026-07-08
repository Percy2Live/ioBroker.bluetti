# ioBroker.repositories Submission Entry

**Date:** 2026-07-08
**Issue:** #93
**Fork:** [Percy2Live/ioBroker.repositories](https://github.com/Percy2Live/ioBroker.repositories)
**Branch:** `add-bluetti-adapter`
**Commit:** `5139bac`

## Entry

```json
"bluetti": {
  "meta": "https://raw.githubusercontent.com/Percy2Live/ioBroker.bluetti/main/io-package.json",
  "icon": "https://raw.githubusercontent.com/Percy2Live/ioBroker.bluetti/main/admin/bluetti.png",
  "type": "energy"
}
```

Alphabetically inserted between `bluesound` and `bmw` in `sources-dist.json`.

## Metadata sourced from io-package.json

| Field | Value | Source |
|-------|-------|--------|
| `meta` | raw GitHub URL to `io-package.json` on `main` | `common.extIcon` pattern |
| `icon` | raw GitHub URL to `admin/bluetti.png` on `main` | `common.extIcon` |
| `type` | `energy` | `common.type` |

## Validation

- Entry format matches all other entries in `sources-dist.json` (3 fields: `meta`, `icon`, `type`)
- `type: "energy"` matches `io-package.json` `common.type`
- `meta` URL points to `main` branch (not `master`) — matches repo default
- `icon` URL uses the same `main` branch pattern as `common.extIcon` in `io-package.json`

## Blocked on

The PR to `ioBroker/ioBroker.repositories` must NOT be opened until:

- **#77** — Trusted Publishing (provenance signing) resolved
- **#78** — npm maintainers (bluefox added as collaborator, E2001)

Once both are resolved, open the PR:
```
gh pr create --repo ioBroker/ioBroker.repositories \
  --head Percy2Live:add-bluetti-adapter \
  --base master \
  --title "Add bluetti adapter to latest repository" \
  --body "New adapter: ioBroker.bluetti — BLUETTI power station telemetry"
```

## Fork branch URL

https://github.com/Percy2Live/ioBroker.repositories/tree/add-bluetti-adapter