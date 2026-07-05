/* eslint-disable jsdoc/require-jsdoc */

import type { BluettiCloudErrorKind } from './bluetti-cloud-provider';

export const MIN_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_BASE_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
export const DEFAULT_BACKOFF_FACTOR = 2;
export const DEFAULT_OUTAGE_THRESHOLD = 3;
export const DEFAULT_STALENESS_THRESHOLD_MS = 5 * 60_000;

// Human-readable reasons exposed via BluettiPollingHealth.outageReason. Auth/config
// problems are reported distinctly from real outage signals so downstream consumers
// never confuse a credential error with an unreachable cloud/device.
export type BluettiOutageReason = '' | 'auth_failed' | 'consecutive_failures' | 'stale_telemetry';

// Error kinds that signal a possibly unreachable/degraded BLUETTI cloud and should
// trigger backoff. 'auth' is deliberately excluded: a 401/403 means the cloud IS
// reachable and the problem is credentials/config, not an outage.
const BACKOFF_ERROR_KINDS: ReadonlySet<BluettiCloudErrorKind> = new Set([
	'timeout',
	'network',
	'http',
	'api',
	'invalid_response',
]);

export function isBackoffErrorKind(kind: BluettiCloudErrorKind): boolean {
	return BACKOFF_ERROR_KINDS.has(kind);
}

export interface BluettiPollingPolicyOptions {
	/** Desired base polling interval; clamped up to `minPollIntervalMs`. */
	basePollIntervalMs?: number;
	/** Hard floor for any computed delay. */
	minPollIntervalMs?: number;
	/** Upper bound for backoff delays. */
	maxBackoffMs?: number;
	/** Exponential growth factor per consecutive failure. */
	backoffFactor?: number;
	/** Consecutive backoff-class failures before an outage is suspected. */
	outageThreshold?: number;
	/** Max age of the last successful poll before telemetry is considered stale. */
	stalenessThresholdMs?: number;
	/** Injectable clock for deterministic tests. */
	now?: () => number;
}

export interface BluettiPollingHealth {
	nextDelayMs: number;
	consecutiveFailures: number;
	outageSuspected: boolean;
	authFailed: boolean;
	telemetryFresh: boolean;
	socStale: boolean;
	outageReason: BluettiOutageReason;
	lastErrorKind: BluettiCloudErrorKind | null;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
}

/**
 * Stateful polling policy for the BLUETTI cloud client: decides the delay before
 * the next poll and exposes health signals, distinguishing recoverable outage
 * signals (timeouts/HTTP/network) from auth/config errors.
 */
export class BluettiPollingPolicy {
	private readonly basePollIntervalMs: number;
	private readonly minPollIntervalMs: number;
	private readonly maxBackoffMs: number;
	private readonly backoffFactor: number;
	private readonly outageThreshold: number;
	private readonly stalenessThresholdMs: number;
	private readonly now: () => number;

	private consecutiveFailures = 0;
	private authFailed = false;
	private lastErrorKind: BluettiCloudErrorKind | null = null;
	private lastSuccessAt: number | null = null;
	private lastFailureAt: number | null = null;

	public constructor(options: BluettiPollingPolicyOptions = {}) {
		this.minPollIntervalMs = Math.max(0, options.minPollIntervalMs ?? MIN_POLL_INTERVAL_MS);
		// Enforce the minimum polling interval floor on the base interval.
		this.basePollIntervalMs = Math.max(
			options.basePollIntervalMs ?? DEFAULT_BASE_POLL_INTERVAL_MS,
			this.minPollIntervalMs,
		);
		this.maxBackoffMs = Math.max(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, this.basePollIntervalMs);
		this.backoffFactor = Math.max(1, options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR);
		this.outageThreshold = Math.max(1, options.outageThreshold ?? DEFAULT_OUTAGE_THRESHOLD);
		this.stalenessThresholdMs = Math.max(0, options.stalenessThresholdMs ?? DEFAULT_STALENESS_THRESHOLD_MS);
		this.now = options.now ?? ((): number => Date.now());
	}

	/** Record a successful poll: clears error state and resets backoff to base. */
	public recordSuccess(): void {
		this.consecutiveFailures = 0;
		this.authFailed = false;
		this.lastErrorKind = null;
		this.lastSuccessAt = this.now();
	}

	// Record a failed poll, classified by error kind.
	public recordFailure(kind: BluettiCloudErrorKind): void {
		this.lastErrorKind = kind;
		this.lastFailureAt = this.now();
		if (isBackoffErrorKind(kind)) {
			this.authFailed = false;
			this.consecutiveFailures += 1;
		} else {
			// Auth/config error: cloud is reachable, so this is not an outage and
			// must not escalate backoff or raise outage suspicion.
			this.authFailed = true;
			this.consecutiveFailures = 0;
		}
	}

	/** Delay before the next poll, honoring the minimum floor and backoff cap. */
	public nextDelayMs(): number {
		if (this.consecutiveFailures === 0) {
			return this.basePollIntervalMs;
		}
		const scaled = this.basePollIntervalMs * this.backoffFactor ** this.consecutiveFailures;
		const bounded = Math.min(scaled, this.maxBackoffMs);
		return Math.max(bounded, this.minPollIntervalMs);
	}

	/** True once the failure streak crosses the outage threshold. */
	public isOutageSuspected(): boolean {
		return this.consecutiveFailures >= this.outageThreshold;
	}

	/** True while the last successful poll is recent enough to trust the telemetry. */
	public isTelemetryFresh(): boolean {
		if (this.lastSuccessAt === null) {
			return false;
		}
		return this.now() - this.lastSuccessAt <= this.stalenessThresholdMs;
	}

	/**
	 * Human-readable reason for a degraded health state. Auth/config errors are
	 * reported as 'auth_failed' and NEVER as an outage; real outage signals map to
	 * 'consecutive_failures', and merely aged telemetry maps to 'stale_telemetry'.
	 */
	public outageReason(): BluettiOutageReason {
		if (this.authFailed) {
			return 'auth_failed';
		}
		if (this.isOutageSuspected()) {
			return 'consecutive_failures';
		}
		if (!this.isTelemetryFresh()) {
			return 'stale_telemetry';
		}
		return '';
	}

	/** Snapshot for a health/outage model. */
	public health(): BluettiPollingHealth {
		const telemetryFresh = this.isTelemetryFresh();
		return {
			nextDelayMs: this.nextDelayMs(),
			consecutiveFailures: this.consecutiveFailures,
			outageSuspected: this.isOutageSuspected(),
			authFailed: this.authFailed,
			telemetryFresh,
			socStale: !telemetryFresh,
			outageReason: this.outageReason(),
			lastErrorKind: this.lastErrorKind,
			lastSuccessAt: this.lastSuccessAt,
			lastFailureAt: this.lastFailureAt,
		};
	}
}
