# Debugging and Diagnostics

Status: draft.

The adapter must be diagnosable without exposing BLUETTI credentials, tokens, account identifiers, or full device serials.

## Planned diagnostic snapshot

A sanitized diagnostic snapshot should include:

- adapter version
- Node.js version
- js-controller version if available
- configured provider
- selected model/device ID, redacted if needed
- last successful update time
- last failure time
- last failure reason
- telemetry freshness
- known telemetry keys seen in the latest payload
- unknown telemetry keys, throttled/deduplicated

## Must never be logged

- password
- access token
- refresh token
- authorization headers
- raw account identifiers
- full raw payloads unless explicitly redacted first

## USV/outage diagnostics

The adapter should expose stale-data and outage-suspicion states, but these are not definitive proof of power loss. Useful external correlation signals include:

- router/FritzBox reachability
- internet probe state
- smart meter / Shelly / energy meter state
- ioBroker host uptime
- separate UPS/NUT state
