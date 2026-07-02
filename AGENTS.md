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

## Secrets
Keine Tokens/Keys in Code, Commits oder PR-Beschreibungen. BLUETTI-OAuth-
Credentials kommen zur Laufzeit aus der Adapter-Config, nie hartkodiert.
