# AGENTS.md — ioBroker.bluetti

Projekt-spezifische Anweisungen für autonome Agents (Hermes/Claude Code). Diese
Datei hat Vorrang vor generischen Persona-Defaults, solange sie dem nicht
widerspricht.

## Stack
TypeScript-ioBroker-Adapter. Build via `@iobroker/adapter-dev` (`build-adapter ts`).
Quellcode in `src/`, Build-Output in `build/`.

## Pflicht vor jedem Commit
Lokal grün, bevor irgendwas rausgeht — in dieser Reihenfolge:

```
npm run check      # tsc --noEmit
npm run lint       # eslint
npm run test       # test:ts + test:package (mocha)
npm run build      # build-adapter ts
```

Rot = nicht committen. Fehler an der Wurzel fixen, kein `--no-verify`,
kein `[skip ci]`, um das Gate zu umgehen.

## Git-Workflow — NIEMALS direkt auf main
main ist protected. Auch mit Push-Rechten: **kein direkter Push auf main.**
Jede Änderung läuft über einen PR, den die CI merged — nicht der Agent.

1. Branch von aktuellem main: `git switch -c hermes/<kurzes-topic>`
2. Arbeiten, lokal testen (siehe oben), committen (Conventional Commits:
   `feat:`, `fix:`, `docs:`, `chore:`).
3. Push: `git push -u origin hermes/<topic>`
4. PR öffnen und auf Auto-Merge stellen:
   ```
   gh pr create --fill --base main
   gh pr merge --auto --squash
   ```
   GitHub merged **erst wenn CI grün** ist. Bei rot bleibt der PR offen.
5. Nach dem Merge wird der Branch automatisch gelöscht (Repo-Setting).

## Bei roter CI
Nicht mergen erzwingen. Logs holen (`gh pr checks`, `gh run view`), Ursache
fixen, neu pushen. Wenn nach zwei Fix-Versuchen weiter rot: PR offen lassen und
Pascal per Telegram melden, mit dem konkreten Fehler — nicht raten und weiter
draufpatchen.

## Auto-Merge für Dependabot — Trust-Grenzen (Review vor Arming)

`.github/workflows/automerge-dependabot.yml` ist ein `workflow_run`-Controller,
der ausschließlich mit Code/Konfiguration aus trusted `main` läuft (Checkout des
Controller-Run-SHA, nie PR-Head/Fork). PR-Inhalte werden nur als JSON-Daten
gelesen, nie ausgeführt oder interpoliert. PR-Tests (`test-and-release.yml`)
sind explizit read-only (`contents: read`); Deploy bleibt tag-only.

Entscheidungen trifft `.github/scripts/dependabot-automerge.cjs` strikt fail
closed nach `.github/auto-merge.json`: nur same-repo-Dependabot-PRs mit
verifizierten Commits, exaktem Head, echten Required-Checks und konservativer
npm-Policy (Production patch, Development patch/minor). Alles andere bleibt im
reviewten Hermes-Weg.

`enabled: false` = Audit-Modus: vollständige Prüfung, null Writes. Aktivierung
von `enabled: true` nur über einen separaten, vor Arming unabhängig reviewten
PR. Bootstrap-/Aktivierungs-PRs vor Auto-Merge-Arming immer erst reviewen
lassen (GitHub verlangt aktuell 0 Approvals); neuer Head = neuer Review. Keine
Abschwächung der Branch Protection, kein PAT, kein `pull_request_target`.

## Secrets
Keine Tokens/Keys in Code, Commits oder PR-Beschreibungen. BLUETTI-OAuth-
Credentials kommen zur Laufzeit aus der Adapter-Config, nie hartkodiert.
