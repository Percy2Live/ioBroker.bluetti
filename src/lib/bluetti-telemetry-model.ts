/* eslint-disable jsdoc/require-jsdoc */

import type { BluettiUserProduct } from './bluetti-cloud-provider';
import type { BluettiPollingHealth } from './bluetti-polling-policy';

export interface TelemetryStateCommon {
	name: string;
	type: 'number' | 'string' | 'boolean';
	role: string;
	read: true;
	write: false;
	unit?: string;
	min?: number;
	max?: number;
}

export interface TelemetryStateDef {
	id: string;
	common: TelemetryStateCommon;
}

export type TelemetryValue = number | string | boolean;

// Device metadata — populated from verified BluettiUserProduct fields.
export const DEVICE_STATES: readonly TelemetryStateDef[] = [
	{
		id: 'device.model',
		common: { name: 'Device model', type: 'string', role: 'info.name', read: true, write: false },
	},
	{ id: 'device.name', common: { name: 'Device name', type: 'string', role: 'info.name', read: true, write: false } },
	{
		id: 'device.serial',
		common: { name: 'Serial number', type: 'string', role: 'info.serial', read: true, write: false },
	},
	{
		id: 'device.online',
		common: { name: 'Device online', type: 'boolean', role: 'indicator.reachable', read: true, write: false },
	},
];

// Battery/power telemetry (Elite 30 V2 feature matrix). Live values are populated
// from TELEMETRY_FIELD_MAP; its fnCodes are upstream candidates pending real-payload
// verification (#9), so the objects are stable even if a code needs correcting.
export const BATTERY_STATES: readonly TelemetryStateDef[] = [
	{
		id: 'battery.soc',
		common: {
			name: 'State of charge',
			type: 'number',
			role: 'value.battery',
			unit: '%',
			min: 0,
			max: 100,
			read: true,
			write: false,
		},
	},
];

export const POWER_STATES: readonly TelemetryStateDef[] = [
	{
		id: 'power.pvInput',
		common: { name: 'PV input power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false },
	},
	{
		id: 'power.gridInput',
		common: { name: 'Grid input power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false },
	},
	{
		id: 'power.acOutput',
		common: { name: 'AC output power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false },
	},
	{
		id: 'power.dcOutput',
		common: { name: 'DC output power', type: 'number', role: 'value.power', unit: 'W', read: true, write: false },
	},
];

// Health / staleness — populated from the polling policy snapshot.
export const HEALTH_STATES: readonly TelemetryStateDef[] = [
	{
		id: 'health.outageSuspected',
		common: {
			name: 'Cloud/device outage suspected',
			type: 'boolean',
			role: 'indicator.maintenance',
			read: true,
			write: false,
		},
	},
	{
		id: 'health.consecutiveFailures',
		common: { name: 'Consecutive poll failures', type: 'number', role: 'value', read: true, write: false },
	},
	{
		id: 'health.authFailed',
		common: {
			name: 'Authentication failed',
			type: 'boolean',
			role: 'indicator.maintenance',
			read: true,
			write: false,
		},
	},
];

export const TELEMETRY_STATES: readonly TelemetryStateDef[] = [
	...DEVICE_STATES,
	...BATTERY_STATES,
	...POWER_STATES,
	...HEALTH_STATES,
];

// Maps BLUETTI stateList `fnCode` values to state ids.
//
// These are CANDIDATE codes from the upstream Home Assistant integration's
// `icon_config.py` (see docs/research/bluetti-ha-api-notes.md), NOT yet confirmed
// against a real EL30V2 `stateList` payload — the exact EL30V2 fnCode set is still
// open (#9). Unknown codes are ignored by the mapper, so a wrong candidate yields
// no value rather than bad data. Finalize once a real payload is available.
export const TELEMETRY_FIELD_MAP: Readonly<Record<string, string>> = {
	SOC: 'battery.soc',
	PVAllTotalPower: 'power.pvInput',
	GridAllTotalPower: 'power.gridInput',
	ACLoadAllTotalPower: 'power.acOutput',
	DCLoadAllTotalPower: 'power.dcOutput',
};

export function toTelemetryNumber(raw: unknown): number | null {
	if (typeof raw === 'number') {
		return Number.isFinite(raw) ? raw : null;
	}
	if (typeof raw === 'string' && raw.trim() !== '') {
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function isOnline(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'online';
}

// Device metadata from verified product fields. Empty strings map to null (skip).
export function mapDeviceMetadata(product: BluettiUserProduct): Record<string, TelemetryValue> {
	const values: Record<string, TelemetryValue> = {};
	const serial = typeof product.sn === 'string' ? product.sn.trim() : '';
	const name = (product.name ?? '').trim();
	const model = (product.model ?? '').trim();
	if (serial !== '') {
		values['device.serial'] = serial;
	}
	if (name !== '') {
		values['device.name'] = name;
	}
	if (model !== '') {
		values['device.model'] = model;
	}
	values['device.online'] = isOnline(product.online);
	return values;
}

// Live telemetry from the stateList using the (currently empty) field map. Only
// numeric values for mapped fnCodes are emitted; unknown fields are ignored.
export function mapTelemetryFields(
	product: BluettiUserProduct,
	fieldMap: Readonly<Record<string, string>> = TELEMETRY_FIELD_MAP,
): Record<string, TelemetryValue> {
	const values: Record<string, TelemetryValue> = {};
	for (const entry of product.stateList ?? []) {
		const stateId = fieldMap[entry.fnCode];
		if (stateId === undefined) {
			continue;
		}
		const numeric = toTelemetryNumber(entry.fnValue);
		if (numeric !== null) {
			values[stateId] = numeric;
		}
	}
	return values;
}

// Health/staleness snapshot from the polling policy.
export function mapHealth(health: BluettiPollingHealth): Record<string, TelemetryValue> {
	return {
		'health.outageSuspected': health.outageSuspected,
		'health.consecutiveFailures': health.consecutiveFailures,
		'health.authFailed': health.authFailed,
	};
}
