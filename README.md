# ioBroker BLUETTI

Read-only ioBroker adapter project for BLUETTI power-station telemetry, starting with **BLUETTI Elite 30 V2** (`EL30V2` / `PR30V2`).

## Status

Early research / planning repository.

No adapter package is published yet. The first implementation step is an API spike against the official BLUETTI Home Assistant integration before scaffolding the ioBroker adapter.

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

## Development plan

The current implementation plan is maintained outside this repository in Hermes during the planning phase. The first repo tasks are:

1. inspect `bluetti-official/bluetti-home-assistant`
2. document verified auth/API endpoints in `docs/research/bluetti-ha-api-notes.md`
3. confirm package/repo naming
4. scaffold the TypeScript ioBroker adapter with `@iobroker/create-adapter`
5. add ioBroker package, integration, lint, build, and repository checker gates

## License

MIT
