/* eslint-disable jsdoc/require-jsdoc */

export const BLUETTI_GATEWAY_BASE_URL = 'https://gw.bluettipower.com';

const USER_DEVICES_PATH = '/api/bluiotdata/ha/v1/devices';
const DEVICE_STATES_PATH = '/api/bluiotdata/ha/v1/deviceStates';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type BluettiCloudStatusState = 'ok' | 'auth_failed' | 'cloud_unreachable' | 'provider_error';
export type BluettiCloudErrorKind = 'auth' | 'timeout' | 'network' | 'http' | 'api' | 'invalid_response';

export interface BluettiTokenProvider {
	getAccessToken(): Promise<string>;
	refreshAccessToken?(): Promise<string>;
	markTokenExpired?(): Promise<void>;
}

export interface BluettiCloudProviderOptions {
	tokenProvider: BluettiTokenProvider;
	fetchImpl?: typeof fetch;
	gatewayBaseUrl?: string;
	requestTimeoutMs?: number;
}

export interface BluettiUnifyResponse<T> {
	msgId?: string;
	msgCode: number;
	data: T;
}

export interface BluettiUserProduct {
	sn: string;
	stateList: BluettiStateEntry[];
	online: string;
	model?: string | null;
	name?: string | null;
	isBindByCurUser?: string | null;
}

export interface BluettiStateEntry {
	fnCode: string;
	fnName?: string | null;
	fnValue?: unknown;
	fnType?: string | null;
	supportModeValues?: unknown;
	sensorInfo?: unknown;
}

export class BluettiCloudProviderError extends Error {
	public readonly kind: BluettiCloudErrorKind;
	public readonly statusState: BluettiCloudStatusState;
	public readonly httpStatus?: number;
	public readonly apiCode?: number;
	public readonly cause?: unknown;

	public constructor(
		message: string,
		kind: BluettiCloudErrorKind,
		statusState: BluettiCloudStatusState,
		options: {
			httpStatus?: number;
			apiCode?: number;
			cause?: unknown;
		} = {},
	) {
		super(redactSensitiveText(message));
		this.name = 'BluettiCloudProviderError';
		this.kind = kind;
		this.statusState = statusState;
		this.httpStatus = options.httpStatus;
		this.apiCode = options.apiCode;
		this.cause = options.cause;
	}
}

export class BluettiCloudProvider {
	private readonly tokenProvider: BluettiTokenProvider;
	private readonly fetchImpl: typeof fetch;
	private readonly gatewayBaseUrl: string;
	private readonly requestTimeoutMs: number;

	public constructor(options: BluettiCloudProviderOptions) {
		this.tokenProvider = options.tokenProvider;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.gatewayBaseUrl = (options.gatewayBaseUrl ?? BLUETTI_GATEWAY_BASE_URL).replace(/\/$/, '');
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

		if (!this.fetchImpl) {
			throw new BluettiCloudProviderError(
				'No fetch implementation is available for BLUETTI cloud requests',
				'invalid_response',
				'provider_error',
			);
		}
	}

	public async getUserProducts(): Promise<BluettiUserProduct[]> {
		return await this.request<BluettiUserProduct[]>('GET', USER_DEVICES_PATH);
	}

	public async getDeviceStates(serial: string): Promise<BluettiUserProduct[]> {
		return await this.request<BluettiUserProduct[]>('GET', DEVICE_STATES_PATH, { sns: serial });
	}

	private async request<T>(method: 'GET', path: string, params: Record<string, string> = {}): Promise<T> {
		let accessToken = await this.tokenProvider.getAccessToken();

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await this.requestOnce<T>(method, path, accessToken, params);
			} catch (error) {
				if (isAuthError(error) && attempt === 0 && this.tokenProvider.refreshAccessToken) {
					accessToken = await this.tokenProvider.refreshAccessToken();
					continue;
				}

				throw error;
			}
		}

		throw new BluettiCloudProviderError('BLUETTI cloud request failed after token refresh', 'auth', 'auth_failed');
	}

	private async requestOnce<T>(
		method: 'GET',
		path: string,
		accessToken: string,
		params: Record<string, string>,
	): Promise<T> {
		const url = this.buildUrl(path, params);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

		try {
			const response = await this.fetchImpl(url, {
				method,
				headers: {
					// Verified from bluetti-official Home Assistant integration: bare token, no Bearer prefix.
					Authorization: accessToken,
				},
				signal: controller.signal,
			});

			return await this.handleResponse<T>(response);
		} catch (error) {
			if (isAbortError(error)) {
				throw new BluettiCloudProviderError('BLUETTI cloud request timed out', 'timeout', 'cloud_unreachable', {
					cause: error,
				});
			}

			if (error instanceof BluettiCloudProviderError) {
				throw error;
			}

			throw new BluettiCloudProviderError(
				`BLUETTI cloud request failed: ${extractSafeErrorMessage(error)}`,
				'network',
				'cloud_unreachable',
				{ cause: error },
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private buildUrl(path: string, params: Record<string, string>): string {
		const url = new URL(`${this.gatewayBaseUrl}${path}`);

		for (const [key, value] of Object.entries(params)) {
			if (value !== '') {
				url.searchParams.set(key, value);
			}
		}

		return url.toString();
	}

	private async handleResponse<T>(response: Response): Promise<T> {
		if (response.status === 401 || response.status === 403) {
			await this.tokenProvider.markTokenExpired?.();
			throw new BluettiCloudProviderError('BLUETTI cloud authentication failed', 'auth', 'auth_failed', {
				httpStatus: response.status,
			});
		}

		if (!response.ok) {
			throw new BluettiCloudProviderError(
				`BLUETTI cloud HTTP error ${response.status}: ${await readSafeResponsePreview(response)}`,
				'http',
				'provider_error',
				{ httpStatus: response.status },
			);
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.toLowerCase().includes('application/json')) {
			throw new BluettiCloudProviderError(
				'BLUETTI cloud returned a non-JSON response',
				'invalid_response',
				'provider_error',
			);
		}

		const body = await response.json();
		const apiCode = readApiCode(body);

		if (apiCode === 805) {
			await this.tokenProvider.markTokenExpired?.();
			throw new BluettiCloudProviderError('BLUETTI cloud token expired', 'auth', 'auth_failed', { apiCode });
		}

		if (apiCode !== 0) {
			throw new BluettiCloudProviderError('BLUETTI cloud API returned an error', 'api', 'provider_error', {
				apiCode,
			});
		}

		if (!isObject(body) || !('data' in body)) {
			throw new BluettiCloudProviderError(
				'BLUETTI cloud response is missing data',
				'invalid_response',
				'provider_error',
			);
		}

		return body.data as T;
	}
}

function readApiCode(body: unknown): number | undefined {
	if (!isObject(body)) {
		return undefined;
	}

	const code = typeof body.msgCode === 'number' ? body.msgCode : body.code;
	return typeof code === 'number' ? code : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isAuthError(error: unknown): error is BluettiCloudProviderError {
	return error instanceof BluettiCloudProviderError && error.kind === 'auth';
}

function isAbortError(error: unknown): boolean {
	return isObject(error) && error.name === 'AbortError';
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

export function redactSensitiveText(value: string): string {
	return value
		.replace(/(authorization\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(access[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(refresh[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g, '<redacted-jwt>');
}
