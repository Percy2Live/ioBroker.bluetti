import { expect } from 'chai';

// Mocha imports TypeScript test files as ESM in this scaffold; the explicit .ts
// suffix is needed at runtime, while the main tsc config does not enable it.
// @ts-expect-error Runtime import resolved by ts-node.
import * as telemetry from './bluetti-telemetry-model.ts';

const { TELEMETRY_STATES, mapDeviceMetadata, mapTelemetryFields, mapHealth, toTelemetryNumber } = telemetry;

describe('bluetti telemetry model', () => {
	describe('object definitions', () => {
		it('defines battery.soc as a read-only 0-100 % number', () => {
			const soc = TELEMETRY_STATES.find(s => s.id === 'battery.soc');
			if (!soc) {
				throw new Error('battery.soc state is not defined');
			}
			expect(soc.common.type).to.equal('number');
			expect(soc.common.unit).to.equal('%');
			expect(soc.common.min).to.equal(0);
			expect(soc.common.max).to.equal(100);
			expect(soc.common.read).to.equal(true);
			expect(soc.common.write).to.equal(false);
		});

		it('exposes health/outage-suspicion states', () => {
			const ids = TELEMETRY_STATES.map(s => s.id);
			expect(ids).to.include('health.outageSuspected');
			expect(ids).to.include('health.consecutiveFailures');
			expect(ids).to.include('health.authFailed');
		});

		it('never defines a writable/control state', () => {
			for (const state of TELEMETRY_STATES) {
				expect(state.common.write, `${state.id} must be read-only`).to.equal(false);
				expect(state.common.read).to.equal(true);
			}
		});

		it('has unique state ids', () => {
			const ids = TELEMETRY_STATES.map(s => s.id);
			expect(new Set(ids).size).to.equal(ids.length);
		});
	});

	describe('mapDeviceMetadata', () => {
		it('maps verified product fields and normalizes online', () => {
			const values = mapDeviceMetadata({
				sn: 'SN1',
				name: 'Keller',
				model: 'EL30V2',
				online: '1',
				stateList: [],
			});
			expect(values).to.deep.equal({
				'device.serial': 'SN1',
				'device.name': 'Keller',
				'device.model': 'EL30V2',
				'device.online': true,
			});
		});

		it('skips empty metadata and reports offline', () => {
			const values = mapDeviceMetadata({ sn: 'SN2', online: '0', stateList: [] });
			expect(values).to.deep.equal({ 'device.serial': 'SN2', 'device.online': false });
		});
	});

	describe('mapTelemetryFields', () => {
		it('maps the candidate EL30V2 fnCodes from the default field map', () => {
			const values = mapTelemetryFields({
				sn: 'SN1',
				online: '1',
				stateList: [
					{ fnCode: 'SOC', fnValue: 73 },
					{ fnCode: 'PVAllTotalPower', fnValue: '120' },
					{ fnCode: 'GridAllTotalPower', fnValue: 0 },
					{ fnCode: 'ACLoadAllTotalPower', fnValue: 240 },
					{ fnCode: 'DCLoadAllTotalPower', fnValue: 12 },
					{ fnCode: 'SomeUnknownCode', fnValue: 999 },
				],
			});
			expect(values).to.deep.equal({
				'battery.soc': 73,
				'power.pvInput': 120,
				'power.gridInput': 0,
				'power.acOutput': 240,
				'power.dcOutput': 12,
			});
		});

		it('every field-map target is a defined telemetry state', () => {
			const ids = new Set(TELEMETRY_STATES.map(s => s.id));
			for (const target of Object.values(telemetry.TELEMETRY_FIELD_MAP)) {
				expect(ids.has(target), `${target} must be a defined state`).to.equal(true);
			}
		});

		it('maps numeric fnValues via an injected field map and ignores unknown/non-numeric', () => {
			const values = mapTelemetryFields(
				{
					sn: 'SN1',
					online: '1',
					stateList: [
						{ fnCode: 'SOC', fnValue: 87 },
						{ fnCode: 'AC_OUT', fnValue: '150' },
						{ fnCode: 'JUNK', fnValue: 'not-a-number' },
						{ fnCode: 'UNMAPPED', fnValue: 5 },
					],
				},
				{ SOC: 'battery.soc', AC_OUT: 'power.acOutput', JUNK: 'power.dcOutput' },
			);
			expect(values).to.deep.equal({ 'battery.soc': 87, 'power.acOutput': 150 });
		});
	});

	describe('toTelemetryNumber', () => {
		it('accepts numbers and numeric strings, rejects the rest', () => {
			expect(toTelemetryNumber(12)).to.equal(12);
			expect(toTelemetryNumber('3.5')).to.equal(3.5);
			expect(toTelemetryNumber('')).to.equal(null);
			expect(toTelemetryNumber('abc')).to.equal(null);
			expect(toTelemetryNumber(Number.NaN)).to.equal(null);
			expect(toTelemetryNumber(null)).to.equal(null);
			expect(toTelemetryNumber(undefined)).to.equal(null);
		});
	});

	describe('mapHealth', () => {
		it('maps the polling health snapshot to health states', () => {
			const values = mapHealth({
				nextDelayMs: 60_000,
				consecutiveFailures: 2,
				outageSuspected: false,
				authFailed: true,
				lastErrorKind: 'timeout',
				lastSuccessAt: null,
				lastFailureAt: 123,
			});
			expect(values).to.deep.equal({
				'health.outageSuspected': false,
				'health.consecutiveFailures': 2,
				'health.authFailed': true,
			});
		});
	});
});
