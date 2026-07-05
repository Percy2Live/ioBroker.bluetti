import { expect } from 'chai';

// Mocha imports TypeScript test files as ESM in this scaffold; the explicit .ts
// suffix is needed at runtime, while the main tsc config does not enable it.
// @ts-expect-error Runtime import resolved by ts-node.
import * as diagnostics from './bluetti-diagnostics.ts';
// @ts-expect-error Runtime import resolved by ts-node.
import { TELEMETRY_FIELD_MAP } from './bluetti-telemetry-model.ts';

const { buildDiagnosticsSnapshot, redactSerial, knownTelemetryKeys, UnknownTelemetryKeyTracker } = diagnostics;

describe('bluetti diagnostics', () => {
	describe('buildDiagnosticsSnapshot', () => {
		it('includes all required fields', () => {
			const snapshot = buildDiagnosticsSnapshot({
				adapterVersion: '1.2.3',
				jsControllerVersion: '5.0.19',
				model: 'Elite 30 V2',
				deviceSerial: 'AB12CD34EF56',
				lastApiStatus: 'ok',
				lastSuccessAt: 9_000,
				unknownKeys: ['FooBar'],
				nodeVersion: '20.11.0',
				now: () => 10_000,
			});

			expect(snapshot).to.have.all.keys([
				'adapterVersion',
				'nodeVersion',
				'jsControllerVersion',
				'provider',
				'model',
				'deviceSerial',
				'lastApiStatus',
				'dataAge',
				'knownTelemetryKeys',
				'unknownKeys',
				'timestamp',
			]);
			expect(snapshot.adapterVersion).to.equal('1.2.3');
			expect(snapshot.nodeVersion).to.equal('20.11.0');
			expect(snapshot.jsControllerVersion).to.equal('5.0.19');
			expect(snapshot.provider).to.equal('bluetti-cloud');
			expect(snapshot.model).to.equal('Elite 30 V2');
			expect(snapshot.lastApiStatus).to.equal('ok');
			expect(snapshot.timestamp).to.equal(new Date(10_000).toISOString());
		});

		it('truncates the device serial and never exposes the full value', () => {
			const snapshot = buildDiagnosticsSnapshot({
				adapterVersion: '1.0.0',
				deviceSerial: 'AB12CD34EF56',
			});
			expect(snapshot.deviceSerial).to.equal('AB12***');
			expect(snapshot.deviceSerial).to.not.contain('CD34');
		});

		it('redacts tokens/credentials leaking into free-text status and model', () => {
			const snapshot = buildDiagnosticsSnapshot({
				adapterVersion: '1.0.0',
				model: 'access_token=supersecretvalue',
				lastApiStatus: 'refresh_token=anothersecret',
			});
			expect(snapshot.model).to.contain('<redacted>');
			expect(snapshot.model).to.not.contain('supersecretvalue');
			expect(snapshot.lastApiStatus).to.contain('<redacted>');
			expect(snapshot.lastApiStatus).to.not.contain('anothersecret');
		});

		it('computes data age from lastSuccessAt using the injected clock', () => {
			const snapshot = buildDiagnosticsSnapshot({
				adapterVersion: '1.0.0',
				lastSuccessAt: 4_000,
				now: () => 10_000,
			});
			expect(snapshot.dataAge).to.equal(6_000);
		});

		it('reports null data age when no successful poll has happened', () => {
			const snapshot = buildDiagnosticsSnapshot({
				adapterVersion: '1.0.0',
				lastSuccessAt: null,
				now: () => 10_000,
			});
			expect(snapshot.dataAge).to.equal(null);
		});

		it('clamps negative data age (clock skew) to zero', () => {
			const snapshot = buildDiagnosticsSnapshot({
				adapterVersion: '1.0.0',
				lastSuccessAt: 20_000,
				now: () => 10_000,
			});
			expect(snapshot.dataAge).to.equal(0);
		});

		it('defaults optional fields to safe values', () => {
			const snapshot = buildDiagnosticsSnapshot({ adapterVersion: '1.0.0' });
			expect(snapshot.model).to.equal(null);
			expect(snapshot.jsControllerVersion).to.equal(null);
			expect(snapshot.deviceSerial).to.equal('');
			expect(snapshot.lastApiStatus).to.equal('unknown');
			expect(snapshot.unknownKeys).to.deep.equal([]);
		});

		it('exposes the known telemetry keys matching TELEMETRY_FIELD_MAP', () => {
			const snapshot = buildDiagnosticsSnapshot({ adapterVersion: '1.0.0' }, TELEMETRY_FIELD_MAP);
			expect(snapshot.knownTelemetryKeys).to.deep.equal(Object.keys(TELEMETRY_FIELD_MAP));
		});
	});

	describe('redactSerial', () => {
		it('shows only the first four characters followed by ***', () => {
			expect(redactSerial('AB12CD34EF56')).to.equal('AB12***');
		});

		it('fully masks short serials', () => {
			expect(redactSerial('AB12')).to.equal('***');
			expect(redactSerial('AB')).to.equal('***');
		});

		it('returns an empty string for empty/undefined input', () => {
			expect(redactSerial('')).to.equal('');
			expect(redactSerial('   ')).to.equal('');
			expect(redactSerial(undefined)).to.equal('');
			expect(redactSerial(null)).to.equal('');
		});
	});

	describe('knownTelemetryKeys', () => {
		it('matches the TELEMETRY_FIELD_MAP keys', () => {
			expect(knownTelemetryKeys(TELEMETRY_FIELD_MAP)).to.deep.equal(Object.keys(TELEMETRY_FIELD_MAP));
		});
	});

	describe('UnknownTelemetryKeyTracker', () => {
		it('returns only fnCodes not present in the field map', () => {
			const tracker = new UnknownTelemetryKeyTracker(TELEMETRY_FIELD_MAP);
			const newKeys = tracker.track([
				{ fnCode: 'SOC', fnValue: '80' },
				{ fnCode: 'MysteryField', fnValue: '1' },
			]);
			expect(newKeys).to.deep.equal(['MysteryField']);
			expect(tracker.keys()).to.deep.equal(['MysteryField']);
		});

		it('deduplicates unknown keys across multiple polls', () => {
			const tracker = new UnknownTelemetryKeyTracker(TELEMETRY_FIELD_MAP);
			const firstPoll = tracker.track([{ fnCode: 'MysteryField' }, { fnCode: 'OtherField' }]);
			expect(firstPoll).to.deep.equal(['MysteryField', 'OtherField']);

			// A second poll with the same unknown keys yields no newly-seen codes.
			const secondPoll = tracker.track([{ fnCode: 'MysteryField' }, { fnCode: 'OtherField' }]);
			expect(secondPoll).to.deep.equal([]);
			expect(tracker.keys()).to.deep.equal(['MysteryField', 'OtherField']);
		});

		it('reports newly appearing unknown keys once each', () => {
			const tracker = new UnknownTelemetryKeyTracker(TELEMETRY_FIELD_MAP);
			tracker.track([{ fnCode: 'MysteryField' }]);
			const secondPoll = tracker.track([{ fnCode: 'MysteryField' }, { fnCode: 'FreshField' }]);
			expect(secondPoll).to.deep.equal(['FreshField']);
			expect(tracker.keys()).to.deep.equal(['MysteryField', 'FreshField']);
		});

		it('ignores empty/blank fnCodes and missing stateList', () => {
			const tracker = new UnknownTelemetryKeyTracker(TELEMETRY_FIELD_MAP);
			expect(tracker.track(undefined)).to.deep.equal([]);
			expect(tracker.track([{ fnCode: '' }, { fnCode: '   ' }])).to.deep.equal([]);
			expect(tracker.keys()).to.deep.equal([]);
		});
	});
});
