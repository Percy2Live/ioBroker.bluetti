# Telemetry Schema

Status: draft.

This document tracks the planned ioBroker state schema and whether each field is verified on BLUETTI Elite 30 V2.

| State | Unit | v0 target | Verified on EL30V2 | Notes |
|---|---:|---:|---:|---|
| `battery.soc` | `%` | v0.1 | no | Primary SOC target |
| `power.acInput` | `W` | v0.1 | no | Subject to API verification |
| `power.dcInput` | `W` | v0.1 | no | Subject to API verification |
| `power.acOutput` | `W` | v0.1 | no | Subject to API verification |
| `power.dcOutput` | `W` | v0.1 | no | Subject to API verification |
| `health.telemetryFresh` | — | v0.1 | derived | Derived from last successful poll |
| `health.socStale` | — | v0.1 | derived | True when SOC is last-known but stale |
| `health.outageSuspected` | — | v0.1 | derived | Conservative trigger, not definitive proof |
| `battery.remainingWh` | `Wh` | v0.3 | no | Only if real payload supports it |
| `battery.temperature` | `°C` | v0.3 | no | Only if real payload supports it |
| `ups.mode` | — | v0.3 | no | Only if real payload supports it |
| `ups.bypassActive` | — | v0.3 | no | Only if real payload supports it |

Unknown/unverified values must not be invented. Unsupported states should be absent or null according to ioBroker conventions after implementation decisions.
