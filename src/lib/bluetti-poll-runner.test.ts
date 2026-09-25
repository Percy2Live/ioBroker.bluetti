import { expect } from 'chai';
import type { BluettiCloudErrorKind } from './bluetti-cloud-provider';

// Mocha imports TypeScript test files as ESM in this scaffold; the explicit .ts
// suffix is needed at runtime, while the main tsc config does not enable it.
// @ts-expect-error Runtime import resolved by ts-node.
import { BluettiPollRunner } from './bluetti-poll-runner.ts';
// @ts-expect-error Runtime import resolved by ts-node.
import { BluettiPollingPolicy } from './bluetti-polling-policy.ts';

interface ScheduledTimer {
	callback: () => void;
	delayMs: number;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// Flush the microtask queue so the async tick() chain settles.
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
	}
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function makeHarness(
	runPoll: () => Promise<void>,
	classifyError: (e: unknown) => BluettiCloudErrorKind = () => 'network',
	pollTimeoutMs?: number,
) {
	const timers: ScheduledTimer[] = [];
	const cleared: number[] = [];
	const failures: BluettiCloudErrorKind[] = [];
	let successCount = 0;
	const policy = new BluettiPollingPolicy({ basePollIntervalMs: 30_000, backoffFactor: 2, maxBackoffMs: 600_000 });
	const runner = new BluettiPollRunner<number>({
		runPoll,
		classifyError,
		policy,
		pollTimeoutMs,
		setTimer: (callback: () => void, delayMs: number) => {
			timers.push({ callback, delayMs });
			return timers.length - 1;
		},
		clearTimer: (handle: number) => {
			cleared.push(handle);
		},
		onSuccess: () => {
			successCount += 1;
		},
		onFailure: (kind: BluettiCloudErrorKind) => {
			failures.push(kind);
		},
	});
	return {
		runner,
		policy,
		timers,
		cleared,
		failures,
		get successCount(): number {
			return successCount;
		},
	};
}

describe('BluettiPollRunner', () => {
	it('polls immediately on start and schedules the next poll at the base interval', async () => {
		let polls = 0;
		const h = makeHarness(() => {
			polls += 1;
			return Promise.resolve();
		});
		h.runner.start();
		await flush();

		expect(polls).to.equal(1);
		expect(h.successCount).to.equal(1);
		expect(h.timers).to.have.length(1);
		expect(h.timers[0].delayMs).to.equal(30_000);
	});

	it('runs subsequent polls when the scheduled timer fires', async () => {
		let polls = 0;
		const h = makeHarness(() => {
			polls += 1;
			return Promise.resolve();
		});
		h.runner.start();
		await flush();
		h.timers[h.timers.length - 1].callback();
		await flush();

		expect(polls).to.equal(2);
	});

	it('does not start an overlapping poll while one is in flight', async () => {
		let polls = 0;
		const gate = deferred<void>();
		const h = makeHarness(async () => {
			polls += 1;
			await gate.promise;
		});

		h.runner.start();
		await flush();
		// First poll is in flight: no next timer scheduled yet.
		expect(polls).to.equal(1);
		expect(h.timers).to.have.length(0);

		gate.resolve();
		await flush();
		// Only after completion is the next poll scheduled.
		expect(polls).to.equal(1);
		expect(h.timers).to.have.length(1);
	});

	it('classifies failures, backs off, and reports the error kind', async () => {
		const h = makeHarness(
			() => Promise.reject(new Error('boom')),
			() => 'timeout',
		);
		h.runner.start();
		await flush();

		expect(h.failures).to.deep.equal(['timeout']);
		expect(h.successCount).to.equal(0);
		// policy backed off: 30_000 * 2^1
		expect(h.timers[0].delayMs).to.equal(60_000);
	});

	it('stops cleanly and does not reschedule after an in-flight poll finishes', async () => {
		const gate = deferred<void>();
		const h = makeHarness(async () => {
			await gate.promise;
		});
		h.runner.start();
		await flush();
		h.runner.stop();
		expect(h.runner.isActive).to.equal(false);

		gate.resolve();
		await flush();
		expect(h.timers).to.have.length(0);
	});

	it('cancels a pending timer on stop', async () => {
		const h = makeHarness(() => Promise.resolve());
		h.runner.start();
		await flush();
		expect(h.timers).to.have.length(1);

		h.runner.stop();
		expect(h.cleared).to.have.length(1);
	});

	it('reschedules via the watchdog when a poll never settles', async () => {
		// The poll hangs forever: no throw, no resolve. Without a watchdog the
		// finally-based reschedule can never run and the loop wedges (issue #171).
		const gate = deferred<void>();
		const h = makeHarness(
			() => gate.promise,
			() => 'network',
			45_000,
		);

		h.runner.start();
		await flush();
		// Only the watchdog is armed; no reschedule yet while the poll is in flight.
		expect(h.timers).to.have.length(1);
		expect(h.timers[0].delayMs).to.equal(45_000);
		expect(h.failures).to.deep.equal([]);

		// Watchdog fires: the stuck cycle is abandoned and treated as a timeout.
		h.timers[0].callback();
		await flush();

		expect(h.failures).to.deep.equal(['timeout']);
		// Next poll scheduled with backoff for one consecutive failure: 30_000 * 2^1.
		expect(h.timers).to.have.length(2);
		expect(h.timers[1].delayMs).to.equal(60_000);
	});

	it('clears the watchdog when the poll completes in time', async () => {
		const h = makeHarness(
			() => Promise.resolve(),
			() => 'network',
			45_000,
		);
		h.runner.start();
		await flush();

		expect(h.successCount).to.equal(1);
		// Watchdog (handle 0) armed then cleared; next poll (handle 1) scheduled.
		expect(h.cleared).to.deep.equal([0]);
		expect(h.timers[1].delayMs).to.equal(30_000);
	});

	it('does not double-reschedule when an abandoned poll settles late', async () => {
		const gate = deferred<void>();
		const h = makeHarness(
			() => gate.promise,
			() => 'network',
			45_000,
		);
		h.runner.start();
		await flush();
		h.timers[0].callback(); // watchdog fires -> reschedule
		await flush();
		expect(h.timers).to.have.length(2);

		// The abandoned poll finally settles: it must not schedule a second poll.
		gate.resolve();
		await flush();
		expect(h.timers).to.have.length(2);
	});
});
