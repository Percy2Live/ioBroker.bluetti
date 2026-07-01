import { expect } from 'chai';
import type { BluettiTokenProvider } from './bluetti-cloud-provider';

// Mocha imports TypeScript test files as ESM in this scaffold; the explicit .ts
// suffix is needed at runtime, while the main tsc config does not enable it.
// @ts-expect-error Runtime import resolved by ts-node.
import { BluettiCloudProvider, BluettiCloudProviderError, redactSensitiveText } from './bluetti-cloud-provider.ts';

interface FetchCall {
	url: string;
	init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json',
		},
	});
}

function textResponse(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/plain',
		},
	});
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.toString();
	}

	return input.url;
}

function getAuthorizationHeader(init?: RequestInit): string | undefined {
	const headers = init?.headers as Record<string, string> | undefined;
	return headers?.Authorization;
}

describe('BluettiCloudProvider', () => {
	it('calls the verified device list endpoint with a bare Authorization token', async () => {
		const calls: FetchCall[] = [];
		const tokenProvider: BluettiTokenProvider = {
			getAccessToken: () => Promise.resolve('access-token-secret'),
		};
		const fetchImpl: typeof fetch = (input, init) => {
			calls.push({ url: requestUrl(input), init });
			return Promise.resolve(
				jsonResponse({
					msgCode: 0,
					data: [
						{
							sn: 'AC3001234567890',
							stateList: [],
							online: '1',
							model: 'EL30V2',
							name: 'Elite 30',
						},
					],
				}),
			);
		};

		const provider = new BluettiCloudProvider({ tokenProvider, fetchImpl });
		const products = await provider.getUserProducts();

		expect(products).to.have.length(1);
		expect(products[0].model).to.equal('EL30V2');
		expect(calls).to.have.length(1);
		expect(calls[0].url).to.equal('https://gw.bluettipower.com/api/bluiotdata/ha/v1/devices');
		expect(getAuthorizationHeader(calls[0].init)).to.equal('access-token-secret');
		expect(getAuthorizationHeader(calls[0].init)).not.to.match(/^Bearer /);
	});

	it('calls the verified device state endpoint with the serial query parameter', async () => {
		const calls: FetchCall[] = [];
		const tokenProvider: BluettiTokenProvider = {
			getAccessToken: () => Promise.resolve('state-token-secret'),
		};
		const fetchImpl: typeof fetch = (input, init) => {
			calls.push({ url: requestUrl(input), init });
			return Promise.resolve(
				jsonResponse({ msgCode: 0, data: [{ sn: 'EL30V2-SN', stateList: [], online: '1' }] }),
			);
		};

		const provider = new BluettiCloudProvider({ tokenProvider, fetchImpl });
		await provider.getDeviceStates('EL30V2-SN');

		expect(calls).to.have.length(1);
		expect(calls[0].url).to.equal('https://gw.bluettipower.com/api/bluiotdata/ha/v1/deviceStates?sns=EL30V2-SN');
	});

	it('marks an expired token, refreshes it once and retries auth failures', async () => {
		const calls: FetchCall[] = [];
		let markTokenExpiredCalls = 0;
		const tokenProvider: BluettiTokenProvider = {
			getAccessToken: () => Promise.resolve('stale-token-secret'),
			refreshAccessToken: () => Promise.resolve('fresh-token-secret'),
			markTokenExpired: () => {
				markTokenExpiredCalls++;
				return Promise.resolve();
			},
		};
		const fetchImpl: typeof fetch = (input, init) => {
			calls.push({ url: requestUrl(input), init });
			if (calls.length === 1) {
				return Promise.resolve(jsonResponse({ msgCode: 0, data: null }, 401));
			}

			return Promise.resolve(jsonResponse({ msgCode: 0, data: [] }));
		};

		const provider = new BluettiCloudProvider({ tokenProvider, fetchImpl });
		const products = await provider.getUserProducts();

		expect(products).to.deep.equal([]);
		expect(markTokenExpiredCalls).to.equal(1);
		expect(calls).to.have.length(2);
		expect(getAuthorizationHeader(calls[0].init)).to.equal('stale-token-secret');
		expect(getAuthorizationHeader(calls[1].init)).to.equal('fresh-token-secret');
	});

	it('maps HTTP auth failures to auth status without leaking the response body', async () => {
		const tokenProvider: BluettiTokenProvider = {
			getAccessToken: () => Promise.resolve('auth-token-secret'),
		};
		const fetchImpl: typeof fetch = () => Promise.resolve(textResponse('Authorization: auth-token-secret', 403));
		const provider = new BluettiCloudProvider({ tokenProvider, fetchImpl });

		try {
			await provider.getUserProducts();
			expect.fail('Expected an auth error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiCloudProviderError);
			const providerError = error as InstanceType<typeof BluettiCloudProviderError>;
			expect(providerError.kind).to.equal('auth');
			expect(providerError.statusState).to.equal('auth_failed');
			expect(providerError.httpStatus).to.equal(403);
			expect(providerError.message).not.to.include('auth-token-secret');
		}
	});

	it('maps BLUETTI token-expiry code 805 to auth status', async () => {
		let markTokenExpiredCalls = 0;
		const tokenProvider: BluettiTokenProvider = {
			getAccessToken: () => Promise.resolve('expired-token-secret'),
			markTokenExpired: () => {
				markTokenExpiredCalls++;
				return Promise.resolve();
			},
		};
		const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse({ msgCode: 805, data: null }));
		const provider = new BluettiCloudProvider({ tokenProvider, fetchImpl });

		try {
			await provider.getUserProducts();
			expect.fail('Expected a token-expiry error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiCloudProviderError);
			const providerError = error as InstanceType<typeof BluettiCloudProviderError>;
			expect(providerError.kind).to.equal('auth');
			expect(providerError.statusState).to.equal('auth_failed');
			expect(providerError.apiCode).to.equal(805);
			expect(markTokenExpiredCalls).to.equal(1);
		}
	});

	it('maps request timeouts to cloud reachability status', async () => {
		const tokenProvider: BluettiTokenProvider = {
			getAccessToken: () => Promise.resolve('timeout-token-secret'),
		};
		const fetchImpl: typeof fetch = (_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					const error = new Error('aborted');
					error.name = 'AbortError';
					reject(error);
				});
			});
		};
		const provider = new BluettiCloudProvider({ tokenProvider, fetchImpl, requestTimeoutMs: 1 });

		try {
			await provider.getUserProducts();
			expect.fail('Expected a timeout error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiCloudProviderError);
			const providerError = error as InstanceType<typeof BluettiCloudProviderError>;
			expect(providerError.kind).to.equal('timeout');
			expect(providerError.statusState).to.equal('cloud_unreachable');
		}
	});

	it('redacts tokens from sanitized provider messages', async () => {
		const tokenProvider: BluettiTokenProvider = {
			getAccessToken: () => Promise.resolve('safe-token-secret'),
		};
		const fetchImpl: typeof fetch = () =>
			Promise.resolve(textResponse('access_token=super-secret-access-token-1234567890', 500));
		const provider = new BluettiCloudProvider({ tokenProvider, fetchImpl });

		try {
			await provider.getUserProducts();
			expect.fail('Expected an HTTP error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiCloudProviderError);
			expect((error as Error).message).not.to.include('super-secret-access-token-1234567890');
		}

		expect(redactSensitiveText('Authorization: safe-token-secret')).to.equal('Authorization: <redacted>');
	});
});
