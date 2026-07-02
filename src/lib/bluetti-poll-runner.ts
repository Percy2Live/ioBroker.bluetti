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
		void this.tick();
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
			void this.tick();
		}, this.options.policy.nextDelayMs());
	}

	private async tick(): Promise<void> {
		// Overlap guard: never run two polls concurrently.
		if (this.polling) {
			return;
		}
		this.polling = true;
		try {
			await this.options.runPoll();
			this.options.policy.recordSuccess();
			await this.options.onSuccess?.();
		} catch (error) {
			const kind = this.options.classifyError(error);
			this.options.policy.recordFailure(kind);
			await this.options.onFailure?.(kind, error);
		} finally {
			this.polling = false;
			this.scheduleNext();
		}
	}
}
