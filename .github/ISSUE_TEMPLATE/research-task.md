---
name: Research task
about: Track an API, telemetry, or ioBroker compatibility research task
title: ""
labels: research
assignees: ""
---

## Goal

## Sources

## Questions to answer

## Autonomy

- [ ] This is read-only research and may be handled by AI
- [ ] No real BLUETTI credentials or account access required
- [ ] No production ioBroker instance may be touched
- [ ] Expected risk: `risk:low` / `risk:medium` / `risk:high`
- [ ] Add `needs-human` if real hardware/account validation is required

## Acceptance criteria

- [ ] Findings are backed by source links or real sanitized payloads
- [ ] Unknowns are documented explicitly
- [ ] No secrets or raw account identifiers are included

## Verification

Required before PR if files are changed:

- [ ] `npm run check`
- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run build`
