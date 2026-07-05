# Telemetry Schema

Status: draft.

This document tracks the planned ioBroker state schema and whether each field is verified on BLUETTI Elite 30 V2.

Verification against a real EL30V2 `deviceStates` payload was performed on
2026-07-05 (fnCodes recorded in `docs/research/bluetti-ha-api-notes.md`,
section "Verified Elite 30 V2 payload").

| State | Unit | v0 target | Verified on EL30V2 | fnCode | Notes |
|---|---:|---:|---:|---|---|
| `battery.soc` | `%` | v0.1 | yes | `SOC` | Battery charge level |
| `power.pvInput` | `W` | v0.1 | yes | `PVAllTotalPower` | Photovoltaic input power |
| `power.gridInput` | `W` | v0.1 | yes | `GridAllTotalPower` | Grid/AC charging input power |
| `power.acOutput` | `W` | v0.1 | yes | `ACLoadAllTotalPower` | AC load output power |
| `power.dcOutput` | `W` | v0.1 | yes | `DCLoadAllTotalPower` | DC load output power |
| `health.outageSuspected` | — | v0.1 | derived | — | Conservative trigger, not definitive proof |
| `battery.dischargeRemaining` | `min` | v0.3 | yes | `DsgFullTime` | Minutes to empty at current load |
| `battery.chargeRemaining` | `min` | v0.3 | yes | `ChgFullTime` | Minutes to full; 0 when not charging |
| `power.acOutputActive` | — | v0.3 | yes | `SetCtrlAc` | AC output on/off, read-only status |
| `power.dcOutputActive` | — | v0.3 | yes | `SetCtrlDc` | DC output on/off, read-only status |
| `power.acEco` | — | v0.3 | yes | `SetACECO` | AC ECO mode, read-only status |
| `power.dcEco` | — | v0.3 | yes | `SetDCECO` | DC ECO mode, read-only status |
| `device.workMode` | — | v0.3 | yes | `SetCtrlWorkMode` | Raw working-mode enum (e.g. `workmode_3`) |
| `battery.remainingWh` | `Wh` | v0.3 | no | — | Not present in EL30V2 payload — not exposed |
| `battery.temperature` | `°C` | v0.3 | no | — | Not present in EL30V2 payload — not exposed |
| `ups.bypassActive` | — | v0.3 | no | — | Not present in EL30V2 payload — not exposed |

The `SetCtrl*`/`Set*ECO` fnCodes are upstream switch/select controls; this adapter
exposes them only as **read-only** status states and never writes them back.

Unknown/unverified values must not be invented. Fields not present in the verified
payload (`battery.remainingWh`, `battery.temperature`, `ups.bypassActive`) remain
unimplemented until a real payload proves them.
