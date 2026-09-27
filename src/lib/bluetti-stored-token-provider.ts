/* eslint-disable jsdoc/require-jsdoc */

import type { BluettiTokenProvider } from './bluetti-cloud-provider';

const DEFAULT_EXPIRY_BUFFER_MS = 30_000;
// A failed refresh caused by rejected credentials (invalid_grant, other 4xx) cannot be
// fixed by retrying: the refresh token is dead until the user re-authenticates (#175).
// Back off for a full hour so we do not hammer the SSO endpoint with a dead token.
const DEFAULT_REFRESH_RETRY_DELAY_MS = 60 * 60 * 1000;
// A transient failure (network error, timeout, 5xx) is expected to clear on its own, so
// only skip roughly the next poll instead of blocking telemetry for the full hour (#178).
const DEFAULT_TRANSIENT_REFRESH_RETRY_DELAY_MS = 60 * 1000;

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
	transientRetryDelayMs?: number;
	onRefreshFailure?: (error: unknown) => void;
}

export type BluettiRefreshFailureClass = 'auth' | 'transient';

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
	private readonly authRetryDelayMs: number;
	private readonly transientRetryDelayMs: number;
	private readonly onRefreshFailure?: (error: unknown) => void;
	private tokenExpired = false;
	private lastRefreshFailureAt?: number;
	private lastRefreshRetryDelayMs?: number;

	public constructor(options: BluettiStoredTokenProviderOptions) {
		this.now = options.now ?? Date.now;
		this.token = parseStoredToken(options.oauthTokenJson, this.now);
		this.refreshTokenCallback = options.refreshToken;
		this.persistTokenCallback = options.persistToken;
		this.expiryBufferMs = options.expiryBufferMs ?? DEFAULT_EXPIRY_BUFFER_MS;
		this.authRetryDelayMs = options.refreshRetryDelayMs ?? DEFAULT_REFRESH_RETRY_DELAY_MS;
		this.transientRetryDelayMs = options.transientRetryDelayMs ?? DEFAULT_TRANSIENT_REFRESH_RETRY_DELAY_MS;
		this.onRefreshFailure = options.onRefreshFailure;
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
			this.lastRefreshRetryDelayMs = undefined;
			await this.persistTokenCallback(refreshedToken, stringifyToken(refreshedToken));

			return refreshedToken.access_token;
		} catch (error) {
			this.lastRefreshFailureAt = this.now();
			// A rejected refresh token needs a long backoff; a transient error only skips
			// the next poll (#178). The class decides how long assertRefreshAllowed throttles.
			this.lastRefreshRetryDelayMs =
				classifyRefreshFailure(error) === 'auth' ? this.authRetryDelayMs : this.transientRetryDelayMs;
			// Surface the underlying reason exactly once per real attempt (throttled polls do
			// not reach this catch), so the original error is visible in the log even though
			// status.lastError is later overwritten by the throttle message (#178).
			this.onRefreshFailure?.(error);

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
			this.lastRefreshRetryDelayMs !== undefined &&
			this.now() - this.lastRefreshFailureAt < this.lastRefreshRetryDelayMs
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

// Decides how long a failed refresh should block further attempts. Duck-typed on the
// BluettiOAuthTokenClientError shape (reason/httpStatus) to avoid a circular import.
// invalid_grant and other 4xx (except 429) mean the credentials are rejected — retrying
// every poll cannot help, so back off long. Everything else (network error, timeout, 5xx,
// 429, and unknown errors) is treated as transient and retried soon (#178).
export function classifyRefreshFailure(error: unknown): BluettiRefreshFailureClass {
	if (!isObject(error)) {
		return 'transient';
	}

	if (error.reason === 'oauth_error') {
		return 'auth';
	}

	const httpStatus = error.httpStatus;
	if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
		return 'auth';
	}

	return 'transient';
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
