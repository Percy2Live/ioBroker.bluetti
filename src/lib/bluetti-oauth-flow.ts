/* eslint-disable jsdoc/require-jsdoc */

import { randomBytes } from 'node:crypto';

export const BLUETTI_SSO_BASE_URL = 'https://sso.bluettipower.com';
export const BLUETTI_OAUTH_AUTHORIZE_PATH = '/oauth2/grant';
export const BLUETTI_OAUTH_TOKEN_PATH = '/oauth2/token';

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

export interface BluettiOAuthFlowOptions {
	clientId: string;
	ssoBaseUrl?: string;
	stateTtlMs?: number;
	randomState?: () => string;
	now?: () => number;
}

export interface BluettiOAuthStartLink {
	state: string;
	callbackUrl: string;
	authorizationUrl: string;
	expiresAt: number;
}

export interface BluettiOAuthCallbackResult {
	code: string;
	state: string;
}

interface PendingOAuthState {
	expiresAt: number;
	callbackUrl: string;
}

type BluettiOAuthFlowErrorReason =
	'missing_code' | 'missing_state' | 'oauth_error' | 'state_mismatch' | 'state_expired';

export class BluettiOAuthFlowError extends Error {
	public readonly reason: BluettiOAuthFlowErrorReason;

	public constructor(reason: BluettiOAuthFlowErrorReason, message: string) {
		super(message);
		this.name = 'BluettiOAuthFlowError';
		this.reason = reason;
	}
}

export class BluettiOAuthFlow {
	private readonly clientId: string;
	private readonly ssoBaseUrl: string;
	private readonly stateTtlMs: number;
	private readonly randomState: () => string;
	private readonly now: () => number;
	private readonly pendingStates = new Map<string, PendingOAuthState>();

	public constructor(options: BluettiOAuthFlowOptions) {
		this.clientId = requireNonEmptyString(options.clientId, 'BLUETTI OAuth client ID');
		this.ssoBaseUrl = (options.ssoBaseUrl ?? BLUETTI_SSO_BASE_URL).replace(/\/$/, '');
		this.stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
		this.randomState = options.randomState ?? createRandomState;
		this.now = options.now ?? Date.now;
	}

	public createStartLink(adminOrigin: string, adapterNamespace: string): BluettiOAuthStartLink {
		const state = this.randomState();
		const callbackUrl = buildIoBrokerOAuthCallbackUrl(adminOrigin, adapterNamespace);
		const expiresAt = this.now() + this.stateTtlMs;
		const authorizationUrl = new URL(`${this.ssoBaseUrl}${BLUETTI_OAUTH_AUTHORIZE_PATH}`);

		authorizationUrl.searchParams.set('response_type', 'code');
		authorizationUrl.searchParams.set('client_id', this.clientId);
		authorizationUrl.searchParams.set('redirect_uri', callbackUrl);
		authorizationUrl.searchParams.set('state', state);

		this.pendingStates.set(state, { expiresAt, callbackUrl });
		this.deleteExpiredStates();

		return {
			state,
			callbackUrl,
			authorizationUrl: authorizationUrl.toString(),
			expiresAt,
		};
	}

	public consumeCallback(query: Record<string, unknown>): BluettiOAuthCallbackResult {
		const oauthError = readSingleString(query.error);
		if (oauthError) {
			throw new BluettiOAuthFlowError('oauth_error', `BLUETTI OAuth callback failed: ${oauthError}`);
		}

		const state = readSingleString(query.state);
		if (!state) {
			throw new BluettiOAuthFlowError('missing_state', 'BLUETTI OAuth callback is missing state');
		}

		const pendingState = this.pendingStates.get(state);
		if (!pendingState) {
			throw new BluettiOAuthFlowError(
				'state_mismatch',
				'BLUETTI OAuth callback state does not match a pending login',
			);
		}

		this.pendingStates.delete(state);

		if (pendingState.expiresAt <= this.now()) {
			throw new BluettiOAuthFlowError('state_expired', 'BLUETTI OAuth callback state has expired');
		}

		const code = readSingleString(query.code);
		if (!code) {
			throw new BluettiOAuthFlowError('missing_code', 'BLUETTI OAuth callback is missing code');
		}

		return { code, state };
	}

	public getPendingStateCount(): number {
		this.deleteExpiredStates();
		return this.pendingStates.size;
	}

	private deleteExpiredStates(): void {
		const now = this.now();
		for (const [state, pendingState] of this.pendingStates.entries()) {
			if (pendingState.expiresAt <= now) {
				this.pendingStates.delete(state);
			}
		}
	}
}

export function buildIoBrokerOAuthCallbackUrl(adminOrigin: string, adapterNamespace: string): string {
	const origin = adminOrigin
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/admin$/i, '');
	const namespace = adapterNamespace.trim().replace(/^\/+|\/+$/g, '');

	if (!origin) {
		throw new BluettiOAuthFlowError('missing_state', 'ioBroker Admin origin is required for BLUETTI OAuth');
	}

	if (!namespace) {
		throw new BluettiOAuthFlowError('missing_state', 'Adapter namespace is required for BLUETTI OAuth');
	}

	return `${origin}/oauth2_callbacks/${encodeURIComponent(namespace)}/`;
}

function requireNonEmptyString(value: string, label: string): string {
	const trimmedValue = value.trim();
	if (!trimmedValue) {
		throw new BluettiOAuthFlowError('missing_state', `${label} is required`);
	}

	return trimmedValue;
}

function createRandomState(): string {
	return randomBytes(24).toString('base64url');
}

function readSingleString(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}

	if (Array.isArray(value) && typeof value[0] === 'string') {
		return value[0];
	}

	return undefined;
}
