# BLUETTI Cloud Polling / Backoff / Rate-Limit Policy

Status: implemented as `src/lib/bluetti-polling-policy.ts` (`BluettiPollingPolicy`).
Wiring into the adapter polling loop is a follow-up (see #16).

The upstream BLUETTI cloud rate limits are not officially documented, so the
policy is conservative and self-adjusting rather than tuned to a known quota.

## Polling interval

- **Base interval**: configurable (`pollInterval`), default `30_000 ms`.
- **Minimum floor**: `15_000 ms`. Any configured or computed interval is clamped
  up to this floor to avoid hammering the cloud, even if a user sets a smaller value.

## Backoff on failure

Failures are classified by `BluettiCloudErrorKind`:

| Kind | Class | Effect |
|---|---|---|
| `timeout`, `network`, `http`, `api`, `invalid_response` | **backoff** | Increments the failure streak; delay grows exponentially. |
| `auth` | **config** | Cloud is reachable (401/403) → not an outage. Sets `authFailed`, does **not** escalate backoff, resets the failure streak. |

Backoff delay after `n` consecutive backoff-class failures:

```
delay = clamp(base * factor^n, min = 15_000 ms, max = 900_000 ms)
```

with `factor = 2` and a cap of `15 min`. This ensures repeated cloud/network
failures do not hammer the API while still retrying periodically.

## Outage suspicion

After `outageThreshold` (default `3`) consecutive backoff-class failures,
`isOutageSuspected()` returns `true`. Auth/config errors never raise outage
suspicion, keeping credential problems distinct from cloud/device outages —
input for the future health/outage model (#6, #8).

## Recovery

A successful poll (`recordSuccess()`) resets the failure streak, clears
`authFailed` and `lastErrorKind`, and returns the next delay to the base
interval — recovery is immediate and predictable.

## Health snapshot

`health()` exposes `{ nextDelayMs, consecutiveFailures, outageSuspected,
authFailed, lastErrorKind, lastSuccessAt, lastFailureAt }` for diagnostics and
the health/outage model. The policy takes an injectable clock (`now`) for
deterministic tests.
