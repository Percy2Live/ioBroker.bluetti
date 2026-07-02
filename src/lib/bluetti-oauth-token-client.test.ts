import { expect } from 'chai';

// Mocha imports TypeScript test files as ESM in this scaffold; the explicit .ts
// suffix is needed at runtime, while the main tsc config does not enable it.
// @ts-expect-error Runtime import resolved by ts-node.
import { BluettiOAuthTokenClient, BluettiOAuthTokenClientError } from './bluetti-oauth-token-client.ts';

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

function requestBody(init?: RequestInit): URLSearchParams {
	const body = init?.body;
	if (body instanceof URLSearchParams) {
		return body;
	}

	throw new Error('Expected URLSearchParams request body');
}

function requestHeaders(init?: RequestInit): Record<string, string> {
	return init?.headers as Record<string, string>;
}

describe('BluettiOAuthTokenClient', () => {
	it('exchanges an authorization code using the BLUETTI token endpoint form body', async () => {
		const calls: FetchCall[] = [];
		const fetchImpl: typeof fetch = (input, init) => {
			calls.push({ url: requestUrl(input), init });
			return Promise.resolve(
				jsonResponse({
					access_token: 'exchanged-access-token-secret',
					refresh_token: 'exchanged-refresh-token-secret',
					expires_in: 3_600,
					token_type: 'bearer',
				}),
			);
		};
		const client = new BluettiOAuthTokenClient({ fetchImpl, now: () => 1_700_000_000_000 });

		const token = await client.exchangeAuthorizationCode(
			'callback-code-secret',
			'http://127.0.0.1:8081/oauth2_callbacks/bluetti.0/',
		);

		expect(token.access_token).to.equal('exchanged-access-token-secret');
		expect(token.refresh_token).to.equal('exchanged-refresh-token-secret');
		expect(token.created_at).to.equal(1_700_000_000);
		expect(calls).to.have.length(1);
		expect(calls[0].url).to.equal('https://sso.bluettipower.com/oauth2/token');
		expect(calls[0].init?.method).to.equal('POST');
		expect(requestHeaders(calls[0].init).Accept).to.equal('application/json');
		expect(requestHeaders(calls[0].init)['Content-Type']).to.equal('application/x-www-form-urlencoded');

		const body = requestBody(calls[0].init);
		expect(body.get('grant_type')).to.equal('authorization_code');
		expect(body.get('code')).to.equal('callback-code-secret');
		expect(body.get('redirect_uri')).to.equal('http://127.0.0.1:8081/oauth2_callbacks/bluetti.0/');
		expect(body.get('client_id')).to.equal('HomeAssistant');
		expect(body.get('client_secret')).to.equal('SG9tZUFzc2lzdGFudA==');
	});

	it('refreshes a token using grant_type refresh_token', async () => {
		const calls: FetchCall[] = [];
		const fetchImpl: typeof fetch = (input, init) => {
			calls.push({ url: requestUrl(input), init });
			return Promise.resolve(
				jsonResponse({
					access_token: 'refreshed-access-token-secret',
					expires_at: 1_800_000_000,
				}),
			);
		};
		const client = new BluettiOAuthTokenClient({ fetchImpl });

		const token = await client.refreshToken('refresh-token-secret');

		expect(token.access_token).to.equal('refreshed-access-token-secret');
		expect(token.expires_at).to.equal(1_800_000_000);
		const body = requestBody(calls[0].init);
		expect(body.get('grant_type')).to.equal('refresh_token');
		expect(body.get('refresh_token')).to.equal('refresh-token-secret');
		expect(body.has('redirect_uri')).to.equal(false);
	});

	it('maps OAuth error responses without leaking code or refresh token values', async () => {
		const fetchImpl: typeof fetch = () =>
			Promise.resolve(
				jsonResponse({
					error: 'invalid_grant',
					error_description: 'refresh_token=refresh-token-secret code=callback-code-secret',
				}),
			);
		const client = new BluettiOAuthTokenClient({ fetchImpl });

		try {
			await client.refreshToken('refresh-token-secret');
			expect.fail('Expected OAuth error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiOAuthTokenClientError);
			expect((error as InstanceType<typeof BluettiOAuthTokenClientError>).reason).to.equal('oauth_error');
			expect((error as Error).message).not.to.include('refresh-token-secret');
			expect((error as Error).message).not.to.include('callback-code-secret');
		}
	});

	it('maps HTTP and invalid JSON responses to structured errors', async () => {
		const httpClient = new BluettiOAuthTokenClient({
			fetchImpl: () => Promise.resolve(textResponse('access_token=leaked-access-token-secret', 500)),
		});

		try {
			await httpClient.refreshToken('refresh-token-secret');
			expect.fail('Expected HTTP error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiOAuthTokenClientError);
			expect((error as InstanceType<typeof BluettiOAuthTokenClientError>).reason).to.equal('http_error');
			expect((error as Error).message).not.to.include('leaked-access-token-secret');
		}

		const invalidClient = new BluettiOAuthTokenClient({
			fetchImpl: () => Promise.resolve(jsonResponse({ refresh_token: 'refresh-without-access-secret' })),
		});

		try {
			await invalidClient.refreshToken('refresh-token-secret');
			expect.fail('Expected invalid response error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiOAuthTokenClientError);
			expect((error as InstanceType<typeof BluettiOAuthTokenClientError>).reason).to.equal('invalid_response');
		}
	});

	it('maps timeouts and network errors to structured errors', async () => {
		const timeoutClient = new BluettiOAuthTokenClient({
			requestTimeoutMs: 1,
			fetchImpl: (_input, init) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						const error = new Error('aborted');
						error.name = 'AbortError';
						reject(error);
					});
				});
			},
		});

		try {
			await timeoutClient.refreshToken('refresh-token-secret');
			expect.fail('Expected timeout error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiOAuthTokenClientError);
			expect((error as InstanceType<typeof BluettiOAuthTokenClientError>).reason).to.equal('timeout');
		}

		const networkClient = new BluettiOAuthTokenClient({
			fetchImpl: () => Promise.reject(new Error('client_secret=secret-value refresh_token=refresh-token-secret')),
		});

		try {
			await networkClient.refreshToken('refresh-token-secret');
			expect.fail('Expected network error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiOAuthTokenClientError);
			expect((error as InstanceType<typeof BluettiOAuthTokenClientError>).reason).to.equal('network_error');
			expect((error as Error).message).not.to.include('secret-value');
			expect((error as Error).message).not.to.include('refresh-token-secret');
		}
	});
});
