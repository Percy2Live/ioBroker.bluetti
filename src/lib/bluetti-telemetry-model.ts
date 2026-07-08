/* eslint-disable jsdoc/require-jsdoc */

import type { BluettiStateEntry, BluettiUserProduct } from './bluetti-cloud-provider';
import type { BluettiPollingHealth } from './bluetti-polling-policy';

export interface TelemetryStateCommon {
	name: string;
	type: 'number' | 'string' | 'boolean';
	role: string;
	read: true;
	write: false;
	desc?: string;
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

// Battery/power telemetry. Live values are populated from TELEMETRY_FIELD_MAP.
// The fnCodes are verified against a real Elite 30 V2 `deviceStates` payload
// (see docs/research/bluetti-ha-api-notes.md, "Verified Elite 30 V2 payload").
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
			desc: 'Battery charge level reported by the Elite 30 V2 (fnCode SOC).',
		},
	},
	{
		id: 'battery.dischargeRemaining',
		common: {
			name: 'Battery discharge time remaining',
			type: 'number',
			role: 'value.interval',
			unit: 'min',
			min: 0,
			read: true,
			write: false,
			desc: 'Estimated minutes until the battery is empty at the current load (fnCode DsgFullTime).',
		},
	},
	{
		id: 'battery.chargeRemaining',
		common: {
			name: 'Battery full-charge time remaining',
			type: 'number',
			role: 'value.interval',
			unit: 'min',
			min: 0,
			read: true,
			write: false,
			desc: 'Estimated minutes until the battery is fully charged; 0 when not charging (fnCode ChgFullTime).',
		},
	},
];

export const POWER_STATES: readonly TelemetryStateDef[] = [
	{
		id: 'power.pvInput',
		common: {
			name: 'PV input power',
			type: 'number',
			role: 'value.power',
			unit: 'W',
			read: true,
			write: false,
			desc: 'Photovoltaic input power (fnCode PVAllTotalPower).',
		},
	},
	{
		id: 'power.gridInput',
		common: {
			name: 'Grid input power',
			type: 'number',
			role: 'value.power',
			unit: 'W',
			read: true,
			write: false,
			desc: 'Grid/AC charging input power (fnCode GridAllTotalPower).',
		},
	},
	{
		id: 'power.acOutput',
		common: {
			name: 'AC output power',
			type: 'number',
			role: 'value.power',
			unit: 'W',
			read: true,
			write: false,
			desc: 'AC load output power (fnCode ACLoadAllTotalPower).',
		},
	},
	{
		id: 'power.dcOutput',
		common: {
			name: 'DC output power',
			type: 'number',
			role: 'value.power',
			unit: 'W',
			read: true,
			write: false,
			desc: 'DC load output power (fnCode DCLoadAllTotalPower).',
		},
	},
	{
		id: 'power.acOutputActive',
		common: {
			name: 'AC output active',
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
			desc: 'Whether the AC output is currently switched on (fnCode SetCtrlAc, read-only status).',
		},
	},
	{
		id: 'power.dcOutputActive',
		common: {
			name: 'DC output active',
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
			desc: 'Whether the DC output is currently switched on (fnCode SetCtrlDc, read-only status).',
		},
	},
	{
		id: 'power.acEco',
		common: {
			name: 'AC ECO mode active',
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
			desc: 'Whether AC ECO power-saving mode is enabled (fnCode SetACECO, read-only status).',
		},
	},
	{
		id: 'power.dcEco',
		common: {
			name: 'DC ECO mode active',
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
			desc: 'Whether DC ECO power-saving mode is enabled (fnCode SetDCECO, read-only status).',
		},
	},
];

// Operational mode reported by the device. When the payload carries a
// supportModeValues lookup, the raw enum value (e.g. "workmode_3") is resolved to
// its human-readable label; otherwise the raw value is exposed as a fallback.
export const MODE_STATES: readonly TelemetryStateDef[] = [
	{
		id: 'device.workMode',
		common: {
			name: 'Working mode',
			type: 'string',
			role: 'text',
			read: true,
			write: false,
			desc: 'Current working mode as reported by the device (fnCode SetCtrlWorkMode).',
		},
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
	{
		id: 'health.telemetryFresh',
		common: {
			name: 'Telemetry fresh',
			type: 'boolean',
			role: 'indicator.maintenance',
			read: true,
			write: false,
		},
	},
	{
		id: 'health.socStale',
		common: {
			name: 'State of charge stale',
			type: 'boolean',
			role: 'indicator.maintenance',
			read: true,
			write: false,
		},
	},
	{
		id: 'health.outageReason',
		common: {
			name: 'Outage reason',
			type: 'string',
			role: 'text',
			read: true,
			write: false,
		},
	},
];

export const TELEMETRY_STATES: readonly TelemetryStateDef[] = [
	...DEVICE_STATES,
	...BATTERY_STATES,
	...POWER_STATES,
	...MODE_STATES,
	...HEALTH_STATES,
];

// Lookup of the declared type per state id, used to convert raw `fnValue`s
// according to the target state's type (single source of truth for value shape).
const STATE_TYPE_BY_ID: Readonly<Record<string, TelemetryStateCommon['type']>> = Object.fromEntries(
	TELEMETRY_STATES.map(state => [state.id, state.common.type]),
);

// Maps BLUETTI stateList `fnCode` values to state ids.
//
// These fnCodes are VERIFIED against a real Elite 30 V2 `deviceStates` payload
// (captured 2026-07-05, see docs/research/bluetti-ha-api-notes.md, "Verified
// Elite 30 V2 payload"). Unknown codes are ignored by the mapper, and values are
// converted to the target state's declared type, so a non-conforming value yields
// no update rather than bad data.
export const TELEMETRY_FIELD_MAP: Readonly<Record<string, string>> = {
	SOC: 'battery.soc',
	DsgFullTime: 'battery.dischargeRemaining',
	ChgFullTime: 'battery.chargeRemaining',
	PVAllTotalPower: 'power.pvInput',
	GridAllTotalPower: 'power.gridInput',
	ACLoadAllTotalPower: 'power.acOutput',
	DCLoadAllTotalPower: 'power.dcOutput',
	SetCtrlAc: 'power.acOutputActive',
	SetCtrlDc: 'power.dcOutputActive',
	SetACECO: 'power.acEco',
	SetDCECO: 'power.dcEco',
	SetCtrlWorkMode: 'device.workMode',
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

// BLUETTI switch/eco states arrive as "1"/"0" strings; accept the common truthy
// spellings and reject anything ambiguous (null → no update).
export function toTelemetryBoolean(raw: unknown): boolean | null {
	if (typeof raw === 'boolean') {
		return raw;
	}
	if (typeof raw === 'number') {
		if (raw === 1) {
			return true;
		}
		if (raw === 0) {
			return false;
		}
		return null;
	}
	if (typeof raw === 'string') {
		const normalized = raw.trim().toLowerCase();
		if (normalized === '1' || normalized === 'true' || normalized === 'on') {
			return true;
		}
		if (normalized === '0' || normalized === 'false' || normalized === 'off') {
			return false;
		}
	}
	return null;
}

// Enum/mode strings (e.g. "workmode_3") are passed through verbatim; empty values
// are skipped so a blank payload does not clobber the last-known mode.
export function toTelemetryString(raw: unknown): string | null {
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		return trimmed === '' ? null : trimmed;
	}
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		return String(raw);
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

// Live telemetry from the stateList using the field map. Each mapped fnValue is
// converted to its target state's declared type (number/boolean/string); unknown
// fnCodes and values that fail conversion are ignored rather than written.
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
		const type = STATE_TYPE_BY_ID[stateId];
		// SELECT-type states (e.g. workMode) carry a supportModeValues lookup that
		// maps the raw fnValue code to a human-readable label; prefer it when present.
		if (type === 'string') {
			const label = resolveModeLabel(entry);
			if (label !== null) {
				values[stateId] = label;
				continue;
			}
		}
		const converted = convertTelemetryValue(type, entry.fnValue);
		if (converted !== null) {
			values[stateId] = converted;
		}
	}
	return values;
}

// Resolves a SELECT-type fnValue (e.g. "workmode_3") to its human-readable label
// via the entry's supportModeValues list (mirrors the official HA integration's
// get_name_for_value). Returns null when the list is absent/malformed or the value
// has no matching code, so callers fall through to the raw string conversion.
export function resolveModeLabel(entry: BluettiStateEntry): string | null {
	const modes = entry.supportModeValues;
	if (!Array.isArray(modes)) {
		return null;
	}
	const fnValue = entry.fnValue;
	if (typeof fnValue !== 'string' && typeof fnValue !== 'number') {
		return null;
	}
	const code = String(fnValue);
	for (const mode of modes) {
		if (
			isObject(mode) &&
			typeof mode.code === 'string' &&
			typeof mode.name === 'string' &&
			mode.code === code &&
			mode.name.trim() !== ''
		) {
			return mode.name.trim();
		}
	}
	return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

// Converts a raw fnValue to the declared state type. Unknown ids default to number
// so injected field maps that reference undeclared states keep the legacy behavior.
function convertTelemetryValue(type: TelemetryStateCommon['type'] | undefined, raw: unknown): TelemetryValue | null {
	if (type === 'boolean') {
		return toTelemetryBoolean(raw);
	}
	if (type === 'string') {
		return toTelemetryString(raw);
	}
	return toTelemetryNumber(raw);
}

// Health/staleness snapshot from the polling policy.
export function mapHealth(health: BluettiPollingHealth): Record<string, TelemetryValue> {
	return {
		'health.outageSuspected': health.outageSuspected,
		'health.consecutiveFailures': health.consecutiveFailures,
		'health.authFailed': health.authFailed,
		'health.telemetryFresh': health.telemetryFresh,
		'health.socStale': health.socStale,
		'health.outageReason': health.outageReason,
	};
}
