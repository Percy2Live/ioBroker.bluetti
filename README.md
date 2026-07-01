![Logo](admin/bluetti.png)

# ioBroker.bluetti

[![NPM version](https://img.shields.io/npm/v/iobroker.bluetti.svg)](https://www.npmjs.com/package/iobroker.bluetti)
[![Downloads](https://img.shields.io/npm/dm/iobroker.bluetti.svg)](https://www.npmjs.com/package/iobroker.bluetti)
![Number of Installations](https://iobroker.live/badges/bluetti-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/bluetti-stable.svg)

**Tests:** ![Test and Release](https://github.com/Percy2Live/ioBroker.bluetti/workflows/Test%20and%20Release/badge.svg)

Read-only ioBroker adapter project for BLUETTI power-station telemetry, starting with **BLUETTI Elite 30 V2** (`EL30V2` / `PR30V2`).

## Status

Early scaffold / implementation repository.

The TypeScript ioBroker adapter scaffold exists. No adapter package is published yet, and real Elite 30 V2 payload values still need validation with sanitized account/device responses before user-facing telemetry states are implemented.

## Goals

- expose BLUETTI Elite 30 V2 SOC in ioBroker
- keep the first versions read-only
- expose health/staleness states for USV-style automations
- support richer Elite 30 V2 telemetry after real payload validation
- prepare for broader BLUETTI model support only when sanitized real-world payloads exist

## Non-goals for the first versions

- no direct Bluetooth/BLE support
- no write/control states
- no UPS mode changes
- no AC/DC switching
- no firmware or device configuration writes

## Planned state model

Initial v0.1 target states:

| State | Type | Purpose |
|---|---|---|
| `info.connection` | boolean | Adapter/provider reachability |
| `battery.soc` | number `%` | Battery state of charge |
| `power.acInput` | number `W` | AC input power |
| `power.dcInput` | number `W` | DC input power |
| `power.acOutput` | number `W` | AC output power |
| `power.dcOutput` | number `W` | DC output power |
| `health.telemetryFresh` | boolean | Whether last telemetry is fresh |
| `health.socStale` | boolean | SOC exists but is stale |
| `health.outageSuspected` | boolean | Conservative outage suspicion trigger |
| `health.outageReason` | string | Reason for outage suspicion |
| `status.lastUpdate` | timestamp | Last successful telemetry update |
| `status.lastError` | string | Last sanitized error |

## Cloud dependency and USV caveat

The first implementation is expected to use the BLUETTI cloud API if the official Home Assistant integration confirms a stable, usable auth and telemetry flow.

A cloud-only adapter **cannot prove a grid outage by itself**. It can only expose evidence such as stale telemetry, cloud reachability, device reachability, and repeated polling failures. Reliable power-outage automations should combine these states with at least one local signal, for example a router/ping check, smart meter, Shelly/energy meter, or a separate UPS signal.

## Development

The adapter was scaffolded with `@iobroker/create-adapter` as a TypeScript class-style adapter with JSON admin config.

## Architecture notes

- [BLUETTI Home Assistant API notes](docs/research/bluetti-ha-api-notes.md) records the source-backed upstream OAuth, token, device, and telemetry findings.
- [BLUETTI auth, token and device selection flow](docs/auth-flow.md) tracks the planned ioBroker OAuth/token/device-selection architecture for issue #15 and the open implementation questions before the adapter should expose a user-facing login flow.

| Script | Purpose |
|---|---|
| `npm run build` | Compile TypeScript sources |
| `npm run check` | Type-check without emitting files |
| `npm run lint` | Run ESLint |
| `npm test` | Run TypeScript and package tests |
| `npm run test:integration` | Run ioBroker startup integration test |
| `npm run test:repo` | Run ioBroker repository checker in local mode |

## Repository checker status

`npm run test:repo` runs `@iobroker/repochecker` in local mode via `npm exec`, because the checker must not be listed as an adapter dependency. The current bootstrap repository still has expected upstream/release findings until the adapter is published, tagged, and submitted to the ioBroker repositories:

- package `iobroker.bluetti` is not published on npm yet
- release `0.0.1` is not tagged yet
- adapter `bluetti` is not present in the latest ioBroker repository yet
- GitHub API access can fail with HTTP 403 in unauthenticated/local checker runs; set `OWN_GITHUB_TOKEN` for authenticated checker runs
- GitHub Actions log retrieval can warn in unauthenticated/local checker runs
- TypeScript version freshness can be reported by the checker and should be evaluated during dependency maintenance

All file-level checker findings that can be fixed before the first release should be fixed in the repository instead of ignored.

## Development plan

The first repo tasks are:

1. inspect `bluetti-official/bluetti-home-assistant`
2. document verified auth/API endpoints in `docs/research/bluetti-ha-api-notes.md`
3. confirm package/repo naming
4. scaffold the TypeScript ioBroker adapter with `@iobroker/create-adapter`
5. add ioBroker package, integration, lint, build, and repository checker gates
6. implement read-only auth/polling against verified sanitized payloads

## Changelog

### 0.0.1

- Initial TypeScript adapter scaffold for BLUETTI telemetry.

Older entries are kept in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT License

Copyright (c) 2026 Percy2Live
