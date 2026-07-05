import { expect } from 'chai';

// Mocha imports TypeScript test files as ESM in this scaffold; the explicit .ts
// suffix is needed at runtime, while the main tsc config does not enable it.
// @ts-expect-error Runtime import resolved by ts-node.
import * as tokenProviderModule from './bluetti-stored-token-provider.ts';

const { BluettiStoredTokenProvider, BluettiStoredTokenProviderError, parseStoredToken, stringifyToken } =
	tokenProviderModule;

describe('BluettiStoredTokenProvider', () => {
	it('returns a valid stored access token without refreshing', async () => {
		let refreshCalls = 0;
		const provider = new BluettiStoredTokenProvider({
			oauthTokenJson: JSON.stringify({
				access_token: 'valid-access-token-secret',
				refresh_token: 'valid-refresh-token-secret',
				expires_at: 2_000,
			}),
			now: () => 1_000_000,
			refreshToken: () => {
				refreshCalls++;
				return Promise.resolve({ access_token: 'unused-token-secret' });
			},
			persistToken: () => Promise.resolve(),
		});

		expect(await provider.getAccessToken()).to.equal('valid-access-token-secret');
		expect(refreshCalls).to.equal(0);
		expect(provider.isAuthenticated()).to.equal(true);
		expect(provider.isTokenNearExpiry()).to.equal(false);
	});

	it('refreshes a token that is inside the expiry buffer and persists the result', async () => {
		const persisted: string[] = [];
		const provider = new BluettiStoredTokenProvider({
			oauthTokenJson: JSON.stringify({
				access_token: 'old-access-token-secret',
				refresh_token: 'old-refresh-token-secret',
				expires_at: 1_020,
			}),
			now: () => 1_000_000,
			refreshToken: currentToken => {
				expect(currentToken.refresh_token).to.equal('old-refresh-token-secret');
				return Promise.resolve({
					access_token: 'new-access-token-secret',
					refresh_token: 'new-refresh-token-secret',
					expires_at: 2_000,
				});
			},
			persistToken: (_token, oauthTokenJson) => {
				persisted.push(oauthTokenJson);
				return Promise.resolve();
			},
		});

		expect(await provider.getAccessToken()).to.equal('new-access-token-secret');
		expect(persisted).to.have.length(1);
		expect(JSON.parse(persisted[0]).access_token).to.equal('new-access-token-secret');
	});

	it('supports created_at plus expires_in and preserves the previous refresh token if refresh omits one', async () => {
		let persistedTokenRefreshToken: string | undefined;
		const provider = new BluettiStoredTokenProvider({
			oauthTokenJson: JSON.stringify({
				access_token: 'created-at-access-token-secret',
				refresh_token: 'kept-refresh-token-secret',
				created_at: 1_000,
				expires_in: 10,
			}),
			now: () => 1_010_000,
			refreshToken: () =>
				Promise.resolve({
					access_token: 'refreshed-access-token-secret',
					created_at: 1_010,
					expires_in: 3_600,
				}),
			persistToken: token => {
				persistedTokenRefreshToken = token.refresh_token;
				return Promise.resolve();
			},
		});

		expect(provider.isTokenNearExpiry()).to.equal(true);
		expect(await provider.refreshAccessToken()).to.equal('refreshed-access-token-secret');
		expect(persistedTokenRefreshToken).to.equal('kept-refresh-token-secret');
	});

	it('reuses a token that carries only expires_in and refreshes only near real expiry (#46)', async () => {
		let now = 1_000_000; // ms; created_at is stamped at load as floor(now / 1000) = 1000 s
		let refreshCalls = 0;
		const persisted: string[] = [];
		const provider = new BluettiStoredTokenProvider({
			// Shape of the live BLUETTI token: no created_at / expires_at, only expires_in.
			oauthTokenJson: JSON.stringify({
				access_token: 'expires-in-only-access-token-secret',
				refresh_token: 'expires-in-only-refresh-token-secret',
				token_type: 'bearer',
				expires_in: 3_600,
			}),
			now: () => now,
			refreshToken: () => {
				refreshCalls++;
				// BLUETTI's refresh response has the same shape: relative lifetime, no timestamp.
				return Promise.resolve({
					access_token: 'refreshed-access-token-secret',
					refresh_token: 'refreshed-refresh-token-secret',
					token_type: 'bearer',
					expires_in: 3_600,
				});
			},
			persistToken: (_token, oauthTokenJson) => {
				persisted.push(oauthTokenJson);
				return Promise.resolve();
			},
		});

		// Expiry is computable from the stamped created_at (1000 s) + expires_in: 4_600_000 ms.
		expect(provider.isTokenNearExpiry()).to.equal(false);

		// Several polls well before expiry reuse the token without a single refresh.
		for (let poll = 0; poll < 5; poll++) {
			now += 60_000;
			expect(await provider.getAccessToken()).to.equal('expires-in-only-access-token-secret');
		}
		expect(refreshCalls).to.equal(0);
		expect(persisted).to.have.length(0);

		// Inside the expiry buffer (10 s before real expiry) exactly one refresh fires.
		now = 4_600_000 - 10_000;
		expect(await provider.getAccessToken()).to.equal('refreshed-access-token-secret');
		expect(refreshCalls).to.equal(1);
		expect(persisted).to.have.length(1);
		// The refreshed token gets a fresh created_at too, so it is not treated as stale.
		expect(JSON.parse(persisted[0]).created_at).to.equal(Math.floor((4_600_000 - 10_000) / 1000));

		// A poll shortly after refresh reuses the new token instead of refreshing again.
		now += 60_000;
		expect(await provider.getAccessToken()).to.equal('refreshed-access-token-secret');
		expect(refreshCalls).to.equal(1);
	});

	it('refreshes after the cloud provider marks the token expired', async () => {
		let refreshCalls = 0;
		const provider = new BluettiStoredTokenProvider({
			oauthTokenJson: JSON.stringify({
				access_token: 'marked-access-token-secret',
				refresh_token: 'marked-refresh-token-secret',
				expires_at: 2_000,
			}),
			now: () => 1_000_000,
			refreshToken: () => {
				refreshCalls++;
				return Promise.resolve({
					access_token: 'after-mark-access-token-secret',
					refresh_token: 'after-mark-refresh-token-secret',
					expires_at: 3_000,
				});
			},
			persistToken: () => Promise.resolve(),
		});

		await provider.markTokenExpired();

		expect(await provider.getAccessToken()).to.equal('after-mark-access-token-secret');
		expect(refreshCalls).to.equal(1);
	});

	it('throttles refresh attempts after a failed refresh and redacts secret-looking error text', async () => {
		let now = 1_000_000;
		const provider = new BluettiStoredTokenProvider({
			oauthTokenJson: JSON.stringify({
				access_token: 'failing-access-token-secret',
				refresh_token: 'failing-refresh-token-secret',
				expires_at: 900,
			}),
			now: () => now,
			refreshRetryDelayMs: 3_600_000,
			refreshToken: () => Promise.reject(new Error('refresh_token=failing-refresh-token-secret')),
			persistToken: () => Promise.resolve(),
		});

		try {
			await provider.getAccessToken();
			expect.fail('Expected refresh failure');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiStoredTokenProviderError);
			expect((error as InstanceType<typeof BluettiStoredTokenProviderError>).reason).to.equal('refresh_failed');
			expect((error as Error).message).not.to.include('failing-refresh-token-secret');
		}

		now += 1_000;

		try {
			await provider.getAccessToken();
			expect.fail('Expected refresh throttle');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiStoredTokenProviderError);
			expect((error as InstanceType<typeof BluettiStoredTokenProviderError>).reason).to.equal(
				'refresh_throttled',
			);
		}
	});

	it('rejects missing and malformed stored tokens', () => {
		expect(parseStoredToken(undefined)).to.equal(undefined);
		expect(() => parseStoredToken('{')).to.throw(BluettiStoredTokenProviderError, 'invalid');
		expect(() => parseStoredToken(JSON.stringify({ refresh_token: 'refresh-without-access-secret' }))).to.throw(
			BluettiStoredTokenProviderError,
			'access_token',
		);
	});

	it('serializes normalized token JSON', () => {
		expect(
			stringifyToken({
				access_token: 'serialized-access-token-secret',
				refresh_token: 'serialized-refresh-token-secret',
				expires_at: 2_000,
				nested: { kept: true },
			}),
		).to.equal(
			JSON.stringify({
				access_token: 'serialized-access-token-secret',
				refresh_token: 'serialized-refresh-token-secret',
				expires_at: 2_000,
				nested: { kept: true },
			}),
		);
	});
});
