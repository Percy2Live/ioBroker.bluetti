# BLUETTI Home Assistant API Notes

Status: not started.

This document will record only verified details from the official BLUETTI Home Assistant integration and related source files.

## Sources to inspect

- https://github.com/bluetti-official/bluetti-home-assistant
- `custom_components/bluetti/*`

## Questions to answer

- OAuth/login flow shape
- token exchange and refresh handling
- API base URLs
- device-list endpoint
- telemetry endpoint
- request headers/auth headers
- rate limits or retry behavior
- EL30V2 / PR30V2 telemetry fields actually returned
- whether the auth flow can fit ioBroker JSON config or needs a richer admin UI

## Verified endpoints

None yet.

## Verified Elite 30 V2 fields

None yet.

## Unknowns / blockers

- exact BLUETTI cloud auth flow
- whether real Elite 30 V2 telemetry includes UPS mode / bypass information
- whether the cloud API distinguishes device-offline from cloud/API outage
