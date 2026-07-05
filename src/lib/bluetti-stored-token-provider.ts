/* eslint-disable jsdoc/require-jsdoc */

import type { BluettiTokenProvider } from './bluetti-cloud-provider';

const DEFAULT_EXPIRY_BUFFER_MS = 30_000;
const DEFAULT_REFRESH_RETRY_DELAY_MS = 60 * 60 * 1000;

export interface BluettiOAuthToken {
	access_token: string;
	refresh_token?: string;
	expires_at?: number;
	expires_in?: number;
	created_at?: number;
	[key: string]: unknown;
}

export interface BluettiStoredTokenProviderOptions {
	oauthTokenJson?: string | null;
	refreshToken: (currentToken: BluettiOAuthToken) => Promise<BluettiOAuthToken>;
	persistToken: (token: BluettiOAuthToken, oauthTokenJson: string) => Promise<void>;
	now?: () => number;
	expiryBufferMs?: number;
	refreshRetryDelayMs?: number;
}

export type BluettiStoredTokenProviderErrorReason =
	| 'missing_token'
	| 'invalid_token_json'
	| 'invalid_token_shape'
	| 'missing_refresh_token'
	| 'refresh_failed'
	| 'refresh_throttled';

export class BluettiStoredTokenProviderError extends Error {
	public readonly reason: BluettiStoredTokenProviderErrorReason;
	public readonly cause?: unknown;

	public constructor(
		reason: BluettiStoredTokenProviderErrorReason,
		message: string,
		options: { cause?: unknown } = {},
	) {
		super(redactSensitiveText(message));
		this.name = 'BluettiStoredTokenProviderError';
		this.reason = reason;
		this.cause = options.cause;
	}
}

export class BluettiStoredTokenProvider implements BluettiTokenProvider {
	private token?: BluettiOAuthToken;
	private readonly refreshTokenCallback: (currentToken: BluettiOAuthToken) => Promise<BluettiOAuthToken>;
	private readonly persistTokenCallback: (token: BluettiOAuthToken, oauthTokenJson: string) => Promise<void>;
	private readonly now: () => number;
	private readonly expiryBufferMs: number;
	private readonly refreshRetryDelayMs: number;
	private tokenExpired = false;
	private lastRefreshFailureAt?: number;

	public constructor(options: BluettiStoredTokenProviderOptions) {
		this.now = options.now ?? Date.now;
		this.token = parseStoredToken(options.oauthTokenJson, this.now);
		this.refreshTokenCallback = options.refreshToken;
		this.persistTokenCallback = options.persistToken;
		this.expiryBufferMs = options.expiryBufferMs ?? DEFAULT_EXPIRY_BUFFER_MS;
		this.refreshRetryDelayMs = options.refreshRetryDelayMs ?? DEFAULT_REFRESH_RETRY_DELAY_MS;
	}

	public async getAccessToken(): Promise<string> {
		const token = this.requireToken();
		if (!this.tokenExpired && !this.isNearExpiry(token)) {
			return token.access_token;
		}

		return await this.refreshAccessToken();
	}

	public async refreshAccessToken(): Promise<string> {
		const currentToken = this.requireToken();
		this.assertRefreshAllowed(currentToken);

		try {
			// Normalize the refresh response first so a fresh created_at is stamped when
			// BLUETTI returns only a relative expires_in. Merging afterwards lets that fresh
			// timestamp override the previous token's stale created_at, while still preserving
			// the previous refresh token if the refresh response omits one.
			const refreshResult = normalizeToken(await this.refreshTokenCallback(currentToken), this.now);
			const refreshedToken = normalizeToken({
				...currentToken,
				...refreshResult,
			});

			this.token = refreshedToken;
			this.tokenExpired = false;
			this.lastRefreshFailureAt = undefined;
			await this.persistTokenCallback(refreshedToken, stringifyToken(refreshedToken));

			return refreshedToken.access_token;
		} catch (error) {
			this.lastRefreshFailureAt = this.now();

			if (error instanceof BluettiStoredTokenProviderError) {
				throw error;
			}

			throw new BluettiStoredTokenProviderError(
				'refresh_failed',
				`BLUETTI OAuth token refresh failed: ${extractSafeErrorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	public markTokenExpired(): Promise<void> {
		this.tokenExpired = true;
		return Promise.resolve();
	}

	public isAuthenticated(): boolean {
		return !!this.token?.access_token;
	}

	public isTokenNearExpiry(): boolean {
		return this.token ? this.isNearExpiry(this.token) : true;
	}

	private requireToken(): BluettiOAuthToken {
		if (!this.token) {
			throw new BluettiStoredTokenProviderError('missing_token', 'BLUETTI OAuth token is not configured');
		}

		return this.token;
	}

	private assertRefreshAllowed(token: BluettiOAuthToken): void {
		if (!token.refresh_token) {
			throw new BluettiStoredTokenProviderError(
				'missing_refresh_token',
				'BLUETTI OAuth refresh token is not configured',
			);
		}

		if (
			this.lastRefreshFailureAt !== undefined &&
			this.now() - this.lastRefreshFailureAt < this.refreshRetryDelayMs
		) {
			throw new BluettiStoredTokenProviderError(
				'refresh_throttled',
				'BLUETTI OAuth token refresh is throttled after a recent failure',
			);
		}
	}

	private isNearExpiry(token: BluettiOAuthToken): boolean {
		const expiresAtMs = getExpiresAtMs(token);
		return expiresAtMs === undefined || expiresAtMs - this.expiryBufferMs <= this.now();
	}
}

export function parseStoredToken(oauthTokenJson?: string | null, now?: () => number): BluettiOAuthToken | undefined {
	if (!oauthTokenJson) {
		return undefined;
	}

	try {
		return normalizeToken(JSON.parse(oauthTokenJson), now);
	} catch (error) {
		if (error instanceof BluettiStoredTokenProviderError) {
			throw error;
		}

		throw new BluettiStoredTokenProviderError(
			'invalid_token_json',
			`BLUETTI OAuth token JSON is invalid: ${extractSafeErrorMessage(error)}`,
			{ cause: error },
		);
	}
}

export function stringifyToken(token: BluettiOAuthToken): string {
	return JSON.stringify(normalizeToken(token));
}

function normalizeToken(value: unknown, now?: () => number): BluettiOAuthToken {
	if (!isObject(value) || typeof value.access_token !== 'string' || !value.access_token) {
		throw new BluettiStoredTokenProviderError('invalid_token_shape', 'BLUETTI OAuth token is missing access_token');
	}

	const token: BluettiOAuthToken = {
		...value,
		access_token: value.access_token,
	};

	if (typeof value.refresh_token === 'string' && value.refresh_token) {
		token.refresh_token = value.refresh_token;
	}

	if (typeof value.expires_at === 'number') {
		token.expires_at = value.expires_at;
	}

	if (typeof value.expires_in === 'number') {
		token.expires_in = value.expires_in;
	}

	if (typeof value.created_at === 'number') {
		token.created_at = value.created_at;
	}

	// BLUETTI's /oauth2/token response carries only a relative lifetime (expires_in),
	// with no created_at/expires_at. Without an issue timestamp getExpiresAtMs() cannot
	// compute an expiry, so isNearExpiry() defaults to true and forces a refresh on every
	// poll (#46). Stamp the receipt time as created_at (epoch seconds, matching
	// BluettiOAuthTokenClient) so the lifetime becomes computable. Only done when a clock
	// is supplied (token load/receipt), and never over an explicit created_at/expires_at,
	// which keeps stringifyToken serialization idempotent.
	if (
		now &&
		token.created_at === undefined &&
		token.expires_at === undefined &&
		typeof token.expires_in === 'number'
	) {
		token.created_at = Math.floor(now() / 1000);
	}

	return token;
}

function getExpiresAtMs(token: BluettiOAuthToken): number | undefined {
	if (typeof token.expires_at === 'number') {
		return normalizeEpochMs(token.expires_at);
	}

	if (typeof token.created_at === 'number' && typeof token.expires_in === 'number') {
		return normalizeEpochMs(token.created_at) + token.expires_in * 1000;
	}

	return undefined;
}

function normalizeEpochMs(value: number): number {
	return value > 10_000_000_000 ? value : value * 1000;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function extractSafeErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return redactSensitiveText(error.message);
	}

	return redactSensitiveText(String(error));
}

function redactSensitiveText(value: string): string {
	return value
		.replace(/(authorization\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(access[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(refresh[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g, '<redacted-jwt>');
}
