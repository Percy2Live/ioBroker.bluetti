# Bluetti Autopilot Policy

This repository is prepared for a Hermes-driven, CI-gated autopilot workflow. The goal is not an unbounded agent swarm: GitHub Issues define the queue, labels define autonomy and risk, Hermes orchestrates the work in isolated clones, and GitHub Branch Protection plus required CI checks decide whether code can merge.

## Current autonomy level

`Percy2Live/ioBroker.bluetti` starts at **L2: CI-gated Auto-Merge for low-risk issues**.

| Risk label | Default behavior |
|---|---|
| `risk:low` | Hermes may implement, open a PR, and arm auto-merge after local verification. |
| `risk:medium` | Hermes may prepare a PR, but the task should be reviewed for scope before unattended repetition. |
| `risk:high` | Analysis or implementation plan only unless Pascal explicitly gives a Go. |
| `needs-human` | Do not implement autonomously. Ask Pascal or document the blocker. |
| `blocked` | Skip until the blocker is removed. |

## Required labels

| Label | Meaning |
|---|---|
| `auto` | Issue is eligible for autonomous handling. |
| `blocked` | Orchestrator must skip the issue. |
| `needs-human` | Human input, credentials, hardware, or operational Go is required. |
| `risk:low` | Small, well-scoped, no credentials/live system/API research required. |
| `risk:medium` | Testable code change, but larger scope or domain judgment required. |
| `risk:high` | Security, release, migration, auth, account, or production-impacting work. |
| `ci-failing` | PR/branch needs CI log inspection and a bounded fix attempt. |

## Queue selection

The autopilot may select exactly one issue at a time unless explicitly told otherwise.

An issue is selectable when all conditions are true:

- it is open
- it has `auto`
- it does not have `blocked`
- it does not have `needs-human`
- it has one of `risk:low`, `risk:medium`, `risk:high`
- no active state entry already exists for the issue
- no open PR already references `Closes #<issue>` or uses the branch pattern for that issue

Default priority is oldest created issue first, with `risk:low` preferred for unattended runs.

## Claiming

Before implementation, Hermes should create or update an issue comment containing:

```md
🤖 Claimed by Hermes autopilot.

State: PREPARE_WORKSPACE
Branch: hermes/issue-<number>-<short-slug>
Policy: docs/autopilot.md
```

If a previous Hermes claim exists, the orchestrator should resume from persisted state instead of creating a duplicate claim.

## Branch and workspace rules

- Always use a fresh clone or an isolated worktree.
- Never work in a shared long-lived checkout.
- Branch pattern: `hermes/issue-<number>-<short-slug>`.
- Never push directly to `main`.
- Do not commit unrelated files.

## Required local verification

Run the commands from `AGENTS.md` before pushing:

```bash
npm run check
npm run lint
npm run test
npm run build
```

Red means stop and fix locally. Do not use `--no-verify`, `[skip ci]`, or forced merges.

## CI failure handling

When CI fails:

1. Fetch failing check names and logs.
2. Classify the failure.
3. Run a targeted fix attempt.
4. Push once and re-check.
5. After two failed CI-fix attempts, leave the PR open, add `ci-failing`, and escalate to Pascal with the concrete error.

## State file

The state schema is documented in `.github/autopilot-state.example.json`. A real unattended runner should keep mutable state outside the repository checkout, for example under Hermes state storage, but must use the same fields.

## Idempotency rules

- If state exists for an issue, resume that state.
- If an open PR exists for the issue, attach to that PR and update state.
- If the branch exists remotely, fetch it instead of creating a duplicate branch.
- If auto-merge is already armed, do not arm it again.
- If the issue is closed, mark state completed and stop.
- If the PR is merged, mark state completed and clean temporary workspace.

## Open work before unattended cron/webhook

Cron/webhook triggering is intentionally not enabled yet. Before enabling it, add:

- durable state storage outside the repo checkout
- event deduplication for webhooks
- retry budget tracking across process restarts
- Telegram escalation only for success/blocker, not noisy no-op runs
- a dry-run mode for queue discovery
