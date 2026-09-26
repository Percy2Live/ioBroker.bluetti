/*
 * Adapter lifecycle tests for the Bluetti main adapter.
 *
 * These exercise onReady/startup behavior against the @iobroker/testing mock
 * adapter core, so no real BLUETTI credentials or network access are required.
 * The mock adapter core is injected into the module cache under the
 * '@iobroker/adapter-core' specifier before main.ts is (re)loaded, so the real
 * `Bluetti extends utils.Adapter` class runs against the in-memory mock DB.
 */

import { expect } from 'chai';
import sinon from 'sinon';
import { MockDatabase } from '@iobroker/testing';

import { mockAdapterCore } from '@iobroker/testing/build/tests/unit/mocks/mockAdapterCore';
import type { MockAdapter } from '@iobroker/testing/build/tests/unit/mocks/mockAdapter';

interface TestConfig {
	deviceSerial?: string;
	pollInterval?: number;
	oauthClientId?: string;
	oauthClientSecret?: string;
}

// Instantiate the real Bluetti adapter class against a fresh mock DB. main.ts is
// reloaded per call with the mock adapter core in place, so each adapter binds to
// its own database while the real config/lifecycle code path stays intact.
function createAdapter(config: TestConfig): { adapter: MockAdapter; database: MockDatabase } {
	const database = new MockDatabase();
	let created: MockAdapter | undefined;
	const adapterCoreMock = mockAdapterCore(database, {
		onAdapterCreated: adapter => {
			created = adapter;
		},
	});

	const adapterCoreId = require.resolve('@iobroker/adapter-core');
	const previousCore = require.cache[adapterCoreId];
	require.cache[adapterCoreId] = {
		id: adapterCoreId,
		filename: adapterCoreId,
		loaded: true,
		exports: adapterCoreMock,
	} as NodeModule;

	const mainId = require.resolve('./main.ts');
	delete require.cache[mainId];
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const createBluetti = require('./main.ts') as (options: { config: TestConfig }) => void;
		createBluetti({ config });
	} finally {
		// Restore the real adapter core so unrelated test files are unaffected.
		delete require.cache[mainId];
		if (previousCore) {
			require.cache[adapterCoreId] = previousCore;
		} else {
			delete require.cache[adapterCoreId];
		}
	}

	if (!created) {
		throw new Error('Bluetti adapter mock was not created');
	}

	// The mock adapter core does not implement encrypt()/decrypt(); the token
	// round-trip is irrelevant to these lifecycle tests, so wire identity transforms.
	created.encrypt = ((value: string) => value) as typeof created.encrypt;
	created.decrypt = ((value: string) => value) as typeof created.decrypt;
	return { adapter: created, database };
}

describe('Bluetti adapter lifecycle', () => {
	it('onReady sets info.connection to a conservative false', async () => {
		const { adapter, database } = createAdapter({});

		expect(adapter.readyHandler).to.be.a('function');
		await adapter.readyHandler!();

		const connection = database.getState('bluetti.0.info.connection');
		expect(connection, 'info.connection state should be written').to.not.be.undefined;
		expect(connection!.val).to.equal(false);
		expect(connection!.ack, 'the initial state must be acked').to.equal(true);
	});

	it('onReady creates the auth objects that hold the encrypted token', async () => {
		const { adapter, database } = createAdapter({});

		await adapter.readyHandler!();

		expect(database.hasObject('bluetti.0.auth')).to.equal(true);
		expect(database.hasObject('bluetti.0.auth.tokenJson')).to.equal(true);
	});

	it('does not start polling when neither auth token nor device is configured', async () => {
		const { adapter, database } = createAdapter({});

		await adapter.readyHandler!();

		// No telemetry objects are created because startPolling() bails out early.
		expect(database.hasObject('bluetti.0.battery.soc')).to.equal(false);
		expect(database.hasObject('bluetti.0.device.serial')).to.equal(false);
		// The bail-out is surfaced to the user and connection stays false.
		expect(
			adapter.log.info.calledWith(sinon.match(/polling not started/i)),
			'should log polling not started',
		).to.equal(true);
		expect(database.getState('bluetti.0.info.connection')!.val).to.equal(false);
	});

	it('does not start polling when a device is set but authentication is missing', async () => {
		const { adapter, database } = createAdapter({ deviceSerial: 'BX-123456', pollInterval: 30 });

		await adapter.readyHandler!();

		expect(database.hasObject('bluetti.0.battery.soc')).to.equal(false);
		expect(adapter.log.info.calledWith(sinon.match(/polling not started/i))).to.equal(true);
	});

	it('does not start polling when authenticated but no device is selected', async () => {
		const { adapter, database } = createAdapter({ pollInterval: 30 });

		// Publish a valid token to the auth state (the token is now stored in a
		// state, not in native config — see #140).
		database.publishState('bluetti.0.auth.tokenJson', { val: '{"access_token":"x"}', ack: true });

		await adapter.readyHandler!();

		expect(database.hasObject('bluetti.0.battery.soc')).to.equal(false);
		expect(adapter.log.info.calledWith(sinon.match(/polling not started/i))).to.equal(true);
		expect(database.getState('bluetti.0.info.connection')!.val).to.equal(false);
	});

	it('re-authentication rebuilds the poll loop with the new token, no restart required (#175)', async () => {
		// A running poll loop is built once at startup from the stored token. After a
		// re-auth the new token is only written to the auth state + in-memory JSON, so
		// the loop must be re-initialised or it keeps using the stale token forever.
		type ReauthInternals = {
			handleGetOAuthStartLink(payload: unknown): { openUrl: string };
			handleOAuthCallback(payload: unknown): Promise<{ result: string }>;
			pollRunner?: { stop(): void };
		};

		const seen: { url: string; auth: string | null }[] = [];
		const json = (body: unknown): Promise<Response> =>
			Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			);
		const device = { sn: 'BX-123456', online: '1', isBindByCurUser: '1', stateList: [] };

		const fetchStub = sinon.stub(globalThis, 'fetch');
		fetchStub.callsFake((input, init) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			seen.push({ url, auth: new Headers(init?.headers).get('authorization') });

			if (url.includes('/oauth2/token')) {
				// Authorization-code exchange returns the new token B.
				return json({
					access_token: 'TOKEN_B',
					refresh_token: 'rB',
					token_type: 'bearer',
					expires_in: 2_678_391,
				});
			}
			if (url.includes('/deviceStates')) {
				return json({ msgCode: 0, message: 'OK', data: [device] });
			}
			if (url.includes('/devices')) {
				return json({ msgCode: 0, message: 'OK', data: [{ ...device, name: 'Home', model: 'AC300' }] });
			}
			// bindDevices
			return json({ msgCode: 0, message: 'OK', data: null });
		});

		try {
			const { adapter, database } = createAdapter({ deviceSerial: 'BX-123456', pollInterval: 30 });
			// The @iobroker/testing mock does not implement the adapter timer helpers,
			// which the poll loop needs once it actually starts. Wire minimal stubs; the
			// reschedule setTimer is a no-op so no real timer leaks past the test.
			(adapter as unknown as { setTimeout: () => unknown }).setTimeout = () => undefined;
			(adapter as unknown as { clearTimeout: () => void }).clearTimeout = () => undefined;
			// Token A is already stored: the initial poll loop binds with TOKEN_A.
			database.publishState('bluetti.0.auth.tokenJson', {
				val: '{"access_token":"TOKEN_A","refresh_token":"rA","token_type":"bearer","expires_in":2678391}',
				ack: true,
			});

			await adapter.readyHandler!();

			const internal = adapter as unknown as ReauthInternals;

			// Simulate the admin OAuth flow: start link (arms the pending state) then callback.
			const start = internal.handleGetOAuthStartLink({ adminOrigin: 'http://localhost:8081' });
			const state = new URL(start.openUrl).searchParams.get('state');
			const result = await internal.handleOAuthCallback({ state, code: 'auth-code-xyz' });
			expect(result.result).to.equal('authenticated');

			// Stop the (rebuilt) loop so no detached poll timer leaks past the test.
			internal.pollRunner?.stop();

			const binds = seen.filter(entry => entry.url.includes('/bindDevices'));
			expect(
				binds.length,
				'device is (re)bound on both the initial start and the re-auth',
			).to.be.greaterThanOrEqual(2);
			expect(binds[0].auth, 'initial poll loop uses the pre-auth token').to.equal('TOKEN_A');
			expect(binds[binds.length - 1].auth, 're-auth must rebuild the poll loop with the new token').to.equal(
				'TOKEN_B',
			);
		} finally {
			fetchStub.restore();
		}
	});

	it('degrades gracefully when the persisted OAuth token is corrupt', async () => {
		const { adapter, database } = createAdapter({ deviceSerial: 'BX-123456', pollInterval: 30 });

		// A corrupt token in the auth state makes the token provider throw during
		// startPolling(). The adapter must degrade gracefully instead of crashing
		// into an uncaught-exception restart loop (see #71). encrypt/decrypt are
		// wired to identity transforms, so the raw string is returned by decrypt().
		database.publishState('bluetti.0.auth.tokenJson', { val: 'GARBAGE', ack: true });

		// readyHandler must resolve (no crash) even though the stored token is invalid.
		await adapter.readyHandler!();

		// Polling never starts, so no telemetry objects are created.
		expect(database.hasObject('bluetti.0.battery.soc')).to.equal(false);
		expect(database.getState('bluetti.0.info.connection')!.val).to.equal(false);

		const lastError = database.getState('bluetti.0.status.lastError');
		expect(lastError, 'status.lastError should be written').to.not.be.undefined;
		expect(lastError!.val).to.match(/invalid|corrupt|token/i);
		expect(
			adapter.log.warn.calledWith(sinon.match(/invalid|corrupt|token/i)),
			'should warn about the corrupt token',
		).to.equal(true);
	});
});
