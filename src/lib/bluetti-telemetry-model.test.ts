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

		it('defines the added EL30V2 telemetry states with correct type/role/unit', () => {
			const byId = new Map(TELEMETRY_STATES.map(s => [s.id, s.common]));
			const expectations: Record<string, { type: string; role: string; unit?: string }> = {
				'battery.dischargeRemaining': { type: 'number', role: 'value.interval', unit: 'min' },
				'battery.chargeRemaining': { type: 'number', role: 'value.interval', unit: 'min' },
				'power.acOutputActive': { type: 'boolean', role: 'indicator' },
				'power.dcOutputActive': { type: 'boolean', role: 'indicator' },
				'power.acEco': { type: 'boolean', role: 'indicator' },
				'power.dcEco': { type: 'boolean', role: 'indicator' },
				'device.workMode': { type: 'string', role: 'text' },
			};
			for (const [id, exp] of Object.entries(expectations)) {
				const common = byId.get(id);
				if (!common) {
					throw new Error(`${id} state is not defined`);
				}
				expect(common.type, `${id} type`).to.equal(exp.type);
				expect(common.role, `${id} role`).to.equal(exp.role);
				expect(common.unit, `${id} unit`).to.equal(exp.unit);
				expect(common.desc, `${id} description`).to.be.a('string').and.not.equal('');
				expect(common.read).to.equal(true);
				expect(common.write).to.equal(false);
			}
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
		// Sanitized real Elite 30 V2 `deviceStates` payload captured 2026-07-05.
		const richEl30V2StateList = [
			{ fnCode: 'SetCtrlWorkMode', fnName: 'Working mode', fnType: 'SELECT', fnValue: 'workmode_3' },
			{ fnCode: 'SetACECO', fnName: 'AC ECO', fnType: 'SWITCH', fnValue: '0' },
			{ fnCode: 'DsgFullTime', fnName: 'Battery Time In Minutes', fnType: 'SENSOR', fnValue: '2592' },
			{ fnCode: 'SOC', fnName: 'Battery Level', fnType: 'SENSOR', fnValue: '79' },
			{ fnCode: 'SetDCECO', fnName: 'DC ECO', fnType: 'SWITCH', fnValue: '1' },
			{ fnCode: 'ChgFullTime', fnName: 'Full Charge Time In Minutes', fnType: 'SENSOR', fnValue: '0' },
			{ fnCode: 'SetCtrlAc', fnName: 'AC', fnType: 'SWITCH', fnValue: '1' },
			{ fnCode: 'PVAllTotalPower', fnName: 'Photovoltaics Input Power', fnType: 'SENSOR', fnValue: '0' },
			{ fnCode: 'GridAllTotalPower', fnName: 'Grid Input Power', fnType: 'SENSOR', fnValue: '241' },
			{ fnCode: 'SetCtrlDc', fnName: 'DC', fnType: 'SWITCH', fnValue: '0' },
			{ fnCode: 'DCLoadAllTotalPower', fnName: 'Direct Current Out Power', fnType: 'SENSOR', fnValue: '0' },
			{
				fnCode: 'ACLoadAllTotalPower',
				fnName: 'Alternating Current Out Power',
				fnType: 'SENSOR',
				fnValue: '241',
			},
		];

		it('maps a minimal payload (SOC only) and ignores everything else', () => {
			const values = mapTelemetryFields({
				sn: 'SN1',
				online: '1',
				stateList: [{ fnCode: 'SOC', fnValue: '79' }],
			});
			expect(values).to.deep.equal({ 'battery.soc': 79 });
		});

		it('maps the full verified EL30V2 payload with correct types', () => {
			const values = mapTelemetryFields({ sn: 'SN1', online: '1', stateList: richEl30V2StateList });
			expect(values).to.deep.equal({
				'battery.soc': 79,
				'battery.dischargeRemaining': 2592,
				'battery.chargeRemaining': 0,
				'power.pvInput': 0,
				'power.gridInput': 241,
				'power.acOutput': 241,
				'power.dcOutput': 0,
				'power.acOutputActive': true,
				'power.dcOutputActive': false,
				'power.acEco': false,
				'power.dcEco': true,
				'device.workMode': 'workmode_3',
			});
		});

		it('ignores unknown extra fnCodes and non-conforming values', () => {
			const values = mapTelemetryFields({
				sn: 'SN1',
				online: '1',
				stateList: [
					{ fnCode: 'SOC', fnValue: '80' },
					{ fnCode: 'FutureUnknownCode', fnValue: '123' },
					{ fnCode: 'DsgFullTime', fnValue: 'n/a' },
					{ fnCode: 'SetCtrlAc', fnValue: 'maybe' },
					{ fnCode: 'device.workMode', fnValue: '' },
				],
			});
			expect(values).to.deep.equal({ 'battery.soc': 80 });
		});

		it('provides at least five verified fields beyond the v0.1 SOC/power set', () => {
			const values = mapTelemetryFields({ sn: 'SN1', online: '1', stateList: richEl30V2StateList });
			const v01 = new Set([
				'battery.soc',
				'power.pvInput',
				'power.gridInput',
				'power.acOutput',
				'power.dcOutput',
			]);
			const added = Object.keys(values).filter(id => !v01.has(id));
			expect(added.length).to.be.at.least(5);
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
