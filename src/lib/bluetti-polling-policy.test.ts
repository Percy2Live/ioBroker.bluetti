import { expect } from 'chai';

// Mocha imports TypeScript test files as ESM in this scaffold; the explicit .ts
// suffix is needed at runtime, while the main tsc config does not enable it.
// @ts-expect-error Runtime import resolved by ts-node.
import { BluettiPollingPolicy, MIN_POLL_INTERVAL_MS, isBackoffErrorKind } from './bluetti-polling-policy.ts';

describe('BluettiPollingPolicy', () => {
	it('returns the base interval while healthy', () => {
		const policy = new BluettiPollingPolicy({ basePollIntervalMs: 30_000 });
		expect(policy.nextDelayMs()).to.equal(30_000);
		policy.recordSuccess();
		expect(policy.nextDelayMs()).to.equal(30_000);
		expect(policy.isOutageSuspected()).to.equal(false);
	});

	it('enforces the minimum poll interval floor on the base interval', () => {
		const policy = new BluettiPollingPolicy({ basePollIntervalMs: 1_000 });
		expect(policy.nextDelayMs()).to.equal(MIN_POLL_INTERVAL_MS);
	});

	it('backs off exponentially on a timeout streak and caps at maxBackoff', () => {
		const policy = new BluettiPollingPolicy({
			basePollIntervalMs: 30_000,
			backoffFactor: 2,
			maxBackoffMs: 120_000,
			outageThreshold: 3,
		});

		policy.recordFailure('timeout');
		expect(policy.nextDelayMs()).to.equal(60_000);
		expect(policy.isOutageSuspected()).to.equal(false);

		policy.recordFailure('network');
		expect(policy.nextDelayMs()).to.equal(120_000); // 30k * 2^2 = 120k

		policy.recordFailure('http');
		expect(policy.nextDelayMs()).to.equal(120_000); // 30k * 2^3 = 240k -> capped
		expect(policy.isOutageSuspected()).to.equal(true);
	});

	it('treats auth errors as config problems, not outages', () => {
		const policy = new BluettiPollingPolicy({ basePollIntervalMs: 30_000, outageThreshold: 3 });

		policy.recordFailure('timeout');
		policy.recordFailure('timeout');
		expect(policy.health().consecutiveFailures).to.equal(2);

		policy.recordFailure('auth');
		const health = policy.health();
		expect(health.authFailed).to.equal(true);
		expect(health.outageSuspected).to.equal(false);
		expect(health.consecutiveFailures).to.equal(0);
		// Auth failure means the cloud is reachable -> no backoff escalation.
		expect(policy.nextDelayMs()).to.equal(30_000);
	});

	it('recovers to the base interval and clears error state after success', () => {
		const policy = new BluettiPollingPolicy({ basePollIntervalMs: 30_000 });
		policy.recordFailure('timeout');
		policy.recordFailure('timeout');
		policy.recordFailure('timeout');
		expect(policy.isOutageSuspected()).to.equal(true);

		policy.recordSuccess();
		const health = policy.health();
		expect(health.consecutiveFailures).to.equal(0);
		expect(health.outageSuspected).to.equal(false);
		expect(health.authFailed).to.equal(false);
		expect(health.lastErrorKind).to.equal(null);
		expect(policy.nextDelayMs()).to.equal(30_000);
	});

	it('records success/failure timestamps from the injected clock', () => {
		let clock = 1_000;
		const policy = new BluettiPollingPolicy({ now: () => clock });

		clock = 5_000;
		policy.recordFailure('network');
		clock = 9_000;
		policy.recordSuccess();

		const health = policy.health();
		expect(health.lastFailureAt).to.equal(5_000);
		expect(health.lastSuccessAt).to.equal(9_000);
		expect(health.lastErrorKind).to.equal(null);
	});

	it('classifies backoff-worthy error kinds', () => {
		expect(isBackoffErrorKind('timeout')).to.equal(true);
		expect(isBackoffErrorKind('network')).to.equal(true);
		expect(isBackoffErrorKind('http')).to.equal(true);
		expect(isBackoffErrorKind('api')).to.equal(true);
		expect(isBackoffErrorKind('invalid_response')).to.equal(true);
		expect(isBackoffErrorKind('auth')).to.equal(false);
	});
});
