/* eslint-disable jsdoc/require-jsdoc */

import type { BluettiStateEntry } from './bluetti-cloud-provider';

// Sanitized diagnostic snapshot for bug reports and future-model support. Every
// field is safe to paste into a public issue: credentials, tokens and full
// device serials/account identifiers are redacted or truncated before they land
// here (see redactSerial and redactSensitiveText).
export interface BluettiDiagnosticsSnapshot {
	adapterVersion: string;
	nodeVersion: string;
	jsControllerVersion: string | null;
	provider: 'bluetti-cloud';
	model: string | null;
	deviceSerial: string;
	lastApiStatus: string;
	dataAge: number | null;
	knownTelemetryKeys: string[];
	unknownKeys: string[];
	timestamp: string;
}

export interface BluettiDiagnosticsInput {
	adapterVersion: string;
	jsControllerVersion?: string | null;
	model?: string | null;
	deviceSerial?: string;
	lastApiStatus?: string;
	// Epoch ms of the last successful poll (from BluettiPollingHealth.lastSuccessAt).
	lastSuccessAt?: number | null;
	// Deduplicated fnCodes seen in poll responses that are NOT in TELEMETRY_FIELD_MAP.
	unknownKeys?: readonly string[];
	// Injectable for deterministic tests.
	nodeVersion?: string;
	now?: () => number;
}

// Shows only the first 4 characters of a device serial followed by "***" so a
// snapshot never leaks a full serial (a sensitive account/device identifier).
export function redactSerial(serial: string | undefined | null): string {
	const trimmed = (serial ?? '').trim();
	if (trimmed === '') {
		return '';
	}
	if (trimmed.length <= 4) {
		return '***';
	}
	return `${trimmed.slice(0, 4)}***`;
}

// The known telemetry fnCodes the adapter maps today (TELEMETRY_FIELD_MAP keys).
// Accepts an explicit field map so callers (and tests) can inject their own.
export function knownTelemetryKeys(fieldMap: Readonly<Record<string, string>> = {}): string[] {
	return Object.keys(fieldMap);
}

// Tracks fnCodes that appear in poll responses but are not in the field map, so
// the adapter can log each unknown key once (throttled/deduplicated) instead of
// on every poll cycle. State lives in memory and resets on adapter restart.
export class UnknownTelemetryKeyTracker {
	private readonly seen = new Set<string>();
	private readonly fieldMap: Readonly<Record<string, string>>;

	public constructor(fieldMap: Readonly<Record<string, string>> = {}) {
		this.fieldMap = fieldMap;
	}

	// Records the fnCodes of a stateList and returns the newly-seen unknown codes
	// (deduplicated) so the caller can log them exactly once each.
	public track(stateList: readonly BluettiStateEntry[] | undefined): string[] {
		const newlySeen: string[] = [];
		for (const entry of stateList ?? []) {
			const fnCode = typeof entry?.fnCode === 'string' ? entry.fnCode.trim() : '';
			if (fnCode === '' || this.fieldMap[fnCode] !== undefined || this.seen.has(fnCode)) {
				continue;
			}
			this.seen.add(fnCode);
			newlySeen.push(fnCode);
		}
		return newlySeen;
	}

	// All unknown fnCodes seen so far, deduplicated and in first-seen order.
	public keys(): string[] {
		return [...this.seen];
	}
}

// Builds the sanitized diagnostic snapshot. Free-text fields (model, status) are
// passed through redactSensitiveText as a defense-in-depth measure, and the
// serial is truncated via redactSerial.
export function buildDiagnosticsSnapshot(
	input: BluettiDiagnosticsInput,
	fieldMap: Readonly<Record<string, string>> = {},
): BluettiDiagnosticsSnapshot {
	const now = input.now ?? ((): number => Date.now());
	const nodeVersion = input.nodeVersion ?? process.versions?.node ?? '';
	const lastSuccessAt = input.lastSuccessAt ?? null;
	const dataAge = lastSuccessAt === null ? null : Math.max(0, now() - lastSuccessAt);

	return {
		adapterVersion: input.adapterVersion,
		nodeVersion,
		jsControllerVersion: nullableText(input.jsControllerVersion),
		provider: 'bluetti-cloud',
		model: nullableText(input.model),
		deviceSerial: redactSerial(input.deviceSerial),
		lastApiStatus: redactSensitiveText(input.lastApiStatus ?? 'unknown'),
		dataAge,
		knownTelemetryKeys: knownTelemetryKeys(fieldMap),
		unknownKeys: [...(input.unknownKeys ?? [])],
		timestamp: new Date(now()).toISOString(),
	};
}

// Local copy of the redaction logic (same patterns as redactSensitiveText in
// bluetti-cloud-provider) so this module stays free of runtime imports that
// would break mocha's ESM resolution. Defense-in-depth for free-text fields.
function redactSensitiveText(value: string): string {
	return value
		.replace(/(authorization\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(access[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(refresh[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g, '<redacted-jwt>');
}

function nullableText(value: string | undefined | null): string | null {
	const trimmed = (value ?? '').trim();
	return trimmed === '' ? null : redactSensitiveText(trimmed);
}
