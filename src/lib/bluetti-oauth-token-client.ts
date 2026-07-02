/* eslint-disable jsdoc/require-jsdoc */

import type { BluettiOAuthToken } from './bluetti-stored-token-provider';

export const BLUETTI_OAUTH_TOKEN_BASE_URL = 'https://sso.bluettipower.com';
export const BLUETTI_OAUTH_TOKEN_PATH = '/oauth2/token';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface BluettiOAuthTokenClientOptions {
	clientId: string;
	clientSecret: string;
	fetchImpl?: typeof fetch;
	ssoBaseUrl?: string;
	requestTimeoutMs?: number;
	now?: () => number;
}

export type BluettiOAuthTokenClientErrorReason =
	'http_error' | 'invalid_response' | 'network_error' | 'oauth_error' | 'timeout';

export class BluettiOAuthTokenClientError extends Error {
	public readonly reason: BluettiOAuthTokenClientErrorReason;
	public readonly httpStatus?: number;
	public readonly cause?: unknown;

	public constructor(
		reason: BluettiOAuthTokenClientErrorReason,
		message: string,
		options: { httpStatus?: number; cause?: unknown } = {},
	) {
		super(redactSensitiveText(message));
		this.name = 'BluettiOAuthTokenClientError';
		this.reason = reason;
		this.httpStatus = options.httpStatus;
		this.cause = options.cause;
	}
}

export class BluettiOAuthTokenClient {
	private readonly fetchImpl: typeof fetch;
	private readonly tokenUrl: string;
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly requestTimeoutMs: number;
	private readonly now: () => number;

	public constructor(options: BluettiOAuthTokenClientOptions) {
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.tokenUrl = `${(options.ssoBaseUrl ?? BLUETTI_OAUTH_TOKEN_BASE_URL).replace(/\/$/, '')}${BLUETTI_OAUTH_TOKEN_PATH}`;
		this.clientId = requireNonEmptyString(options.clientId, 'BLUETTI OAuth client ID');
		this.clientSecret = requireNonEmptyString(options.clientSecret, 'BLUETTI OAuth client secret');
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.now = options.now ?? Date.now;

		if (!this.fetchImpl) {
			throw new BluettiOAuthTokenClientError(
				'invalid_response',
				'No fetch implementation is available for BLUETTI OAuth token requests',
			);
		}
	}

	public async exchangeAuthorizationCode(code: string, redirectUri: string): Promise<BluettiOAuthToken> {
		return await this.requestToken({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
		});
	}

	public async refreshToken(refreshToken: string): Promise<BluettiOAuthToken> {
		return await this.requestToken({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		});
	}

	private async requestToken(params: Record<string, string>): Promise<BluettiOAuthToken> {
		const body = this.buildRequestBody(params);

		try {
			const response = await this.fetchImpl(this.tokenUrl, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body,
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});

			return await this.handleResponse(response);
		} catch (error) {
			if (isAbortError(error)) {
				throw new BluettiOAuthTokenClientError('timeout', 'BLUETTI OAuth token request timed out', {
					cause: error,
				});
			}

			if (error instanceof BluettiOAuthTokenClientError) {
				throw error;
			}

			throw new BluettiOAuthTokenClientError(
				'network_error',
				`BLUETTI OAuth token request failed: ${extractSafeErrorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	private buildRequestBody(params: Record<string, string>): URLSearchParams {
		const body = new URLSearchParams();
		body.set('client_id', this.clientId);
		body.set('client_secret', this.clientSecret);

		for (const [key, value] of Object.entries(params)) {
			body.set(key, value);
		}

		return body;
	}

	private async handleResponse(response: Response): Promise<BluettiOAuthToken> {
		if (!response.ok) {
			throw new BluettiOAuthTokenClientError(
				'http_error',
				`BLUETTI OAuth token HTTP error ${response.status}: ${await readSafeResponsePreview(response)}`,
				{ httpStatus: response.status },
			);
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.toLowerCase().includes('application/json')) {
			throw new BluettiOAuthTokenClientError(
				'invalid_response',
				'BLUETTI OAuth token endpoint returned a non-JSON response',
			);
		}

		const body = await response.json();
		if (isObject(body) && typeof body.error === 'string') {
			const description = typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
			throw new BluettiOAuthTokenClientError(
				'oauth_error',
				`BLUETTI OAuth token endpoint returned ${body.error}${description}`,
			);
		}

		return normalizeTokenResponse(body, this.now);
	}
}

function requireNonEmptyString(value: string, label: string): string {
	const trimmedValue = value.trim();
	if (!trimmedValue) {
		throw new BluettiOAuthTokenClientError('invalid_response', `${label} is required`);
	}

	return trimmedValue;
}

function normalizeTokenResponse(body: unknown, now: () => number): BluettiOAuthToken {
	if (!isObject(body) || typeof body.access_token !== 'string' || !body.access_token) {
		throw new BluettiOAuthTokenClientError(
			'invalid_response',
			'BLUETTI OAuth token response is missing access_token',
		);
	}

	const token: BluettiOAuthToken = {
		...body,
		access_token: body.access_token,
	};

	if (typeof body.refresh_token === 'string' && body.refresh_token) {
		token.refresh_token = body.refresh_token;
	}

	if (typeof body.expires_in === 'number') {
		token.expires_in = body.expires_in;
		if (typeof body.created_at !== 'number' && typeof body.expires_at !== 'number') {
			token.created_at = Math.floor(now() / 1000);
		}
	}

	if (typeof body.expires_at === 'number') {
		token.expires_at = body.expires_at;
	}

	if (typeof body.created_at === 'number') {
		token.created_at = body.created_at;
	}

	return token;
}

async function readSafeResponsePreview(response: Response): Promise<string> {
	try {
		return redactSensitiveText((await response.text()).slice(0, 500));
	} catch {
		return '<unreadable response>';
	}
}

function extractSafeErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return redactSensitiveText(error.message);
	}

	return redactSensitiveText(String(error));
}

function isAbortError(error: unknown): boolean {
	return isObject(error) && error.name === 'AbortError';
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function redactSensitiveText(value: string): string {
	return value
		.replace(/(authorization\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(code\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(client[_-]?secret\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(access[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(refresh[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g, '<redacted-jwt>');
}
