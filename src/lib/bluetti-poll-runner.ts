/* eslint-disable jsdoc/require-jsdoc */

import type { BluettiCloudErrorKind } from './bluetti-cloud-provider';
import type { BluettiPollingPolicy } from './bluetti-polling-policy';

export interface BluettiPollRunnerOptions<THandle = unknown> {
	// Perform a single poll; resolve on success, throw on failure.
	runPoll: () => Promise<void>;
	// Map a thrown error to a cloud error kind for the policy and reporting.
	classifyError: (error: unknown) => BluettiCloudErrorKind;
	policy: BluettiPollingPolicy;
	// Schedule the next tick. Inject an adapter-tracked timer (adapter.setTimeout)
	// so shutdown cancels it and no plain setTimeout leaks into the adapter.
	setTimer: (callback: () => void, delayMs: number) => THandle;
	clearTimer: (handle: THandle) => void;
	onSuccess?: () => void | Promise<void>;
	onFailure?: (kind: BluettiCloudErrorKind, error: unknown) => void | Promise<void>;
	// Hard ceiling for a single poll cycle (poll plus success/failure handling).
	// A cycle that does not settle within this window — a hung request or a
	// stalled state write — is abandoned and treated as a 'timeout' failure, so
	// the next poll is always rescheduled. This guarantees that no single stuck
	// poll can permanently stop the loop. Omit or set <= 0 to disable the
	// watchdog (used by the deterministic unit tests).
	pollTimeoutMs?: number;
}

/**
 * Drives the BLUETTI polling lifecycle: one poll at a time (no overlap), the
 * next poll scheduled only after the current finishes using the delay from the
 * polling policy. Success/failure are forwarded to state-mapping callbacks.
 */
export class BluettiPollRunner<THandle = unknown> {
	private readonly options: BluettiPollRunnerOptions<THandle>;
	private active = false;
	private polling = false;
	private timer?: THandle;

	public constructor(options: BluettiPollRunnerOptions<THandle>) {
		this.options = options;
	}

	public get isActive(): boolean {
		return this.active;
	}

	// Start the loop with an immediate first poll.
	public start(): void {
		if (this.active) {
			return;
		}
		this.active = true;
		this.tick();
	}

	// Stop the loop and cancel any pending timer. An in-flight poll finishes but
	// does not reschedule.
	public stop(): void {
		this.active = false;
		if (this.timer !== undefined) {
			this.options.clearTimer(this.timer);
			this.timer = undefined;
		}
	}

	private scheduleNext(): void {
		if (!this.active) {
			return;
		}
		this.timer = this.options.setTimer(() => {
			this.timer = undefined;
			this.tick();
		}, this.options.policy.nextDelayMs());
	}

	private tick(): void {
		// Overlap guard: never run two polls concurrently.
		if (this.polling) {
			return;
		}
		this.polling = true;

		// Reschedule exactly once per tick, whichever comes first: the cycle
		// settling, or the watchdog abandoning a stuck cycle. A `finally` only
		// covers a thrown error; it cannot rescue a poll or state write that
		// hangs and never settles, which would leave the loop wedged forever.
		let rescheduled = false;
		let watchdog: THandle | undefined;
		const reschedule = (): void => {
			if (rescheduled) {
				return;
			}
			rescheduled = true;
			if (watchdog !== undefined) {
				this.options.clearTimer(watchdog);
				watchdog = undefined;
			}
			this.polling = false;
			this.scheduleNext();
		};

		const timeoutMs = this.options.pollTimeoutMs;
		if (timeoutMs !== undefined && timeoutMs > 0) {
			watchdog = this.options.setTimer(() => {
				watchdog = undefined;
				// The cycle exceeded its budget: a request or state write is hung
				// and the cycle promise may never settle. Record a timeout so
				// backoff applies, then abandon it and reschedule. onFailure is
				// fire-and-forget here so a stalled state write cannot re-wedge us.
				this.options.policy.recordFailure('timeout');
				void this.options.onFailure?.('timeout', new Error('BLUETTI poll cycle timed out'));
				reschedule();
			}, timeoutMs);
		}

		// runCycle never rejects (it handles its own errors), but attach to both
		// settle paths defensively so the reschedule always runs.
		void this.runCycle().then(reschedule, reschedule);
	}

	private async runCycle(): Promise<void> {
		try {
			await this.options.runPoll();
			this.options.policy.recordSuccess();
			await this.options.onSuccess?.();
		} catch (error) {
			const kind = this.options.classifyError(error);
			this.options.policy.recordFailure(kind);
			await this.options.onFailure?.(kind, error);
		}
	}
}
