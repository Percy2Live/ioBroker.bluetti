# ioBroker Review Findings Audit (PR #6287 / Claude Checker)

Mapping der Review-Findings zu den erledigenden PRs.
Stand: `main` @ `f1f07f1` (nach PR #154).

## Findings

| # | Finding | Severity | Status | Erledigt in |
|---|---------|----------|--------|-------------|
| 1 | `device.model` Rolle `info.name` → `info.model` | 🔴 | ✅ fixed | PR #142 (Issue #135) |
| 2 | `pollInterval` oberer Clamp im Code erzwingen | 🔴 | ✅ fixed | PR #144 (Issue #137) |
| 3 | i18n: 4 Keys in 9 Sprachen übersetzen | 🟡 | ✅ fixed | PR #147 (Issue #138) |
| 4 | Hardcoded OAuth-Client-Secret: Kommentar erweitern | 🟡 | ✅ fixed | PR #143 (Issue #139) |
| 5 | Ungenutzte Legacy-Native-Felder entfernen | 🟡 | ✅ fixed | PR #146 (Issue #140) |
| 6 | `battery.dischargeRemaining`/`chargeRemaining` Rolle `value.interval`/`unit:'sec'` → `value`/`unit:'min'` | optional | ✅ fixed | PR #145 (Issue #136) |
| 7 | `auth.tokenJson` Security-Doku | — | ✅ documented | PR #148 (Issue #141), commit `7665c72` |

## Migrations-Caveat: `oauthTokenJson`

`native.oauthTokenJson` wurde in PR #146 (#140) aus `io-package.json` entfernt.
Die Token-Migration läuft über `loadStoredToken()` in `src/main.ts:119`,
die den State `auth.tokenJson` (encrypted) liest — nicht mehr native config.
Bestandsinstallationen, die noch `oauthTokenJson` in native config haben,
werden durch den js-controller-Migration-Path behandelt: das Feld wird beim
nächsten Config-Save silent dropped (additionalProperties: false im Schema).

## `noGit` → `nogit` Casing Fix

Separat behandelt in PR #154 (Issue #152). Behebt Repochecker E1105 + E5019.

## Offen (manuell, nicht Teil dieses Issues)

- Frischer Object-Dump von laufender `bluetti.0`-Instanz
- `READY FOR RE_REVIEW`-Kommentar auf ioBroker/ioBroker.repositories#6287