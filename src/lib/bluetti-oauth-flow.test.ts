import { expect } from 'chai';

// Mocha imports TypeScript test files as ESM in this scaffold; the explicit .ts
// suffix is needed at runtime, while the main tsc config does not enable it.
// @ts-expect-error Runtime import resolved by ts-node.
import { BluettiOAuthFlow, BluettiOAuthFlowError, buildIoBrokerOAuthCallbackUrl } from './bluetti-oauth-flow.ts';

describe('BluettiOAuthFlow', () => {
	it('builds a BLUETTI authorization URL for the ioBroker Admin callback', () => {
		const flow = new BluettiOAuthFlow({
			clientId: 'test-client-id',
			randomState: () => 'fixed-state',
			now: () => 1_000,
		});
		const startLink = flow.createStartLink('https://iobroker.example/', 'bluetti.0');
		const authorizationUrl = new URL(startLink.authorizationUrl);

		expect(startLink.state).to.equal('fixed-state');
		expect(startLink.callbackUrl).to.equal('https://iobroker.example/oauth2_callbacks/bluetti.0/');
		expect(startLink.expiresAt).to.equal(601_000);
		expect(authorizationUrl.origin).to.equal('https://sso.bluettipower.com');
		expect(authorizationUrl.pathname).to.equal('/oauth2/grant');
		expect(authorizationUrl.searchParams.get('response_type')).to.equal('code');
		expect(authorizationUrl.searchParams.get('client_id')).to.equal('test-client-id');
		expect(authorizationUrl.searchParams.get('redirect_uri')).to.equal(startLink.callbackUrl);
		expect(authorizationUrl.searchParams.get('state')).to.equal('fixed-state');
	});

	it('normalizes callback origins and namespaces', () => {
		expect(buildIoBrokerOAuthCallbackUrl('http://127.0.0.1:8081/admin////', '/bluetti.0/')).to.equal(
			'http://127.0.0.1:8081/oauth2_callbacks/bluetti.0/',
		);
	});

	it('consumes a valid callback once', () => {
		const flow = new BluettiOAuthFlow({
			clientId: 'test-client-id',
			randomState: () => 'one-shot-state',
			now: () => 10,
		});
		flow.createStartLink('http://127.0.0.1:8081', 'bluetti.0');

		expect(flow.consumeCallback({ code: 'oauth-code', state: 'one-shot-state' })).to.deep.equal({
			code: 'oauth-code',
			state: 'one-shot-state',
		});

		expect(() => flow.consumeCallback({ code: 'oauth-code', state: 'one-shot-state' })).to.throw(
			BluettiOAuthFlowError,
			'pending login',
		);
	});

	it('percent-decodes a still-encoded base64 authorization code', () => {
		const flow = new BluettiOAuthFlow({
			clientId: 'test-client-id',
			randomState: () => 'one-shot-state',
			now: () => 10,
		});
		flow.createStartLink('http://127.0.0.1:8081', 'bluetti.0');

		// The admin forwards the raw query, so the "=" padding arrives as "%3D".
		expect(flow.consumeCallback({ code: 'EApYoX3qew%3D%3D', state: 'one-shot-state' })).to.deep.equal({
			code: 'EApYoX3qew==',
			state: 'one-shot-state',
		});
	});

	it('leaves an already-decoded authorization code untouched', () => {
		const flow = new BluettiOAuthFlow({
			clientId: 'test-client-id',
			randomState: () => 'one-shot-state',
			now: () => 10,
		});
		flow.createStartLink('http://127.0.0.1:8081', 'bluetti.0');

		expect(flow.consumeCallback({ code: 'plain-code==', state: 'one-shot-state' })).to.deep.equal({
			code: 'plain-code==',
			state: 'one-shot-state',
		});
	});

	it('rejects expired callback states', () => {
		let now = 100;
		const flow = new BluettiOAuthFlow({
			clientId: 'test-client-id',
			randomState: () => 'expired-state',
			stateTtlMs: 5,
			now: () => now,
		});
		flow.createStartLink('http://127.0.0.1:8081', 'bluetti.0');

		now = 106;

		expect(() => flow.consumeCallback({ code: 'oauth-code', state: 'expired-state' })).to.throw(
			BluettiOAuthFlowError,
			'expired',
		);
	});

	it('rejects OAuth callback errors without requiring a code', () => {
		const flow = new BluettiOAuthFlow({ clientId: 'test-client-id', randomState: () => 'error-state' });
		flow.createStartLink('http://127.0.0.1:8081', 'bluetti.0');

		try {
			flow.consumeCallback({ error: 'access_denied', state: 'error-state' });
			expect.fail('Expected an OAuth callback error');
		} catch (error) {
			expect(error).to.be.instanceOf(BluettiOAuthFlowError);
			expect((error as InstanceType<typeof BluettiOAuthFlowError>).reason).to.equal('oauth_error');
			expect((error as Error).message).not.to.include('oauth-code');
		}
	});

	it('drops expired pending states while creating new start links', () => {
		let now = 1_000;
		let nextState = 'first-state';
		const flow = new BluettiOAuthFlow({
			clientId: 'test-client-id',
			stateTtlMs: 10,
			now: () => now,
			randomState: () => nextState,
		});

		flow.createStartLink('http://127.0.0.1:8081', 'bluetti.0');
		expect(flow.getPendingStateCount()).to.equal(1);

		now = 1_011;
		nextState = 'second-state';
		flow.createStartLink('http://127.0.0.1:8081', 'bluetti.0');

		expect(flow.getPendingStateCount()).to.equal(1);
	});
});
