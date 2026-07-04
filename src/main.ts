/*
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import { BluettiCloudProvider, BluettiCloudProviderError, type BluettiUserProduct } from './lib/bluetti-cloud-provider';
import { toDeviceSelectItems, type BluettiDeviceSelectItem } from './lib/bluetti-device-selection';
import {
	BluettiOAuthFlow,
	BLUETTI_DEFAULT_CLIENT_ID,
	BLUETTI_DEFAULT_CLIENT_SECRET,
	type BluettiOAuthStartLink,
} from './lib/bluetti-oauth-flow';
import { BluettiOAuthTokenClient } from './lib/bluetti-oauth-token-client';
import { BluettiPollRunner } from './lib/bluetti-poll-runner';
import { BluettiPollingPolicy, type BluettiPollingHealth } from './lib/bluetti-polling-policy';
import { BluettiStoredTokenProvider, stringifyToken } from './lib/bluetti-stored-token-provider';
import {
	TELEMETRY_STATES,
	mapDeviceMetadata,
	mapHealth,
	mapTelemetryFields,
	type TelemetryValue,
} from './lib/bluetti-telemetry-model';

interface PendingOAuthCredentials {
	clientId: string;
	clientSecret: string;
	callbackUrl: string;
}

type NativeAuthConfigUpdate = Partial<
	Pick<ioBroker.AdapterConfig, 'authStatus' | 'oauthLastRefresh' | 'oauthTokenJson'>
>;

class Bluetti extends utils.Adapter {
	private oauthFlow?: BluettiOAuthFlow;
	private readonly pendingOAuthCredentials = new Map<string, PendingOAuthCredentials>();
	private pollRunner?: BluettiPollRunner<ioBroker.Timeout | undefined>;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'bluetti',
		});

		this.on('ready', this.onReady.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	private async onReady(): Promise<void> {
		// Keep the generated scaffold read-only until the BLUETTI cloud API payloads
		// are validated with sanitized real-world data.
		await this.setState('info.connection', false, true);

		const authStatus = this.config.oauthTokenJson ? 'authenticated' : 'not_authenticated';
		await this.persistNativeAuthConfig({ authStatus });

		await this.startPolling();
	}

	// Start the BLUETTI cloud poll loop, but only once authentication and a device
	// have been configured. Without them polling would only ever fail, so we stay
	// idle and leave info.connection false until the admin finishes setup.
	private async startPolling(): Promise<void> {
		const deviceSerial = (this.config.deviceSerial ?? '').trim();
		if (!this.config.oauthTokenJson || deviceSerial === '') {
			this.log.info('BLUETTI polling not started: authenticate and select a device in the adapter settings.');
			return;
		}

		await this.ensureTelemetryObjects();

		const provider = new BluettiCloudProvider({ tokenProvider: this.createStoredTokenProvider() });
		const policy = new BluettiPollingPolicy({ basePollIntervalMs: Math.round(this.config.pollInterval * 1000) });

		this.pollRunner = new BluettiPollRunner<ioBroker.Timeout | undefined>({
			policy,
			runPoll: async () => {
				const products = await provider.getDeviceStates(deviceSerial);
				const product = products.find(candidate => candidate.sn === deviceSerial) ?? products[0];
				if (product) {
					await this.writeTelemetry(product);
				}
			},
			classifyError: error => (error instanceof BluettiCloudProviderError ? error.kind : 'network'),
			setTimer: (callback, delayMs) => this.setTimeout(callback, delayMs),
			clearTimer: handle => this.clearTimeout(handle),
			onSuccess: async () => {
				await this.setState('info.connection', true, true);
				await this.setState('status.lastUpdate', new Date().toISOString(), true);
				await this.setState('status.lastError', '', true);
				await this.writeHealth(policy.health());
			},
			onFailure: async (kind, error) => {
				await this.setState('info.connection', false, true);
				await this.setState('status.lastError', `${kind}: ${extractSafeErrorMessage(error)}`, true);
				await this.writeHealth(policy.health());
			},
		});
		this.pollRunner.start();
		this.log.info(`BLUETTI polling started for device ${deviceSerial} (interval ${this.config.pollInterval}s).`);
	}

	// Creates the centralized read-only telemetry objects (channels + states) if
	// they do not exist yet.
	private async ensureTelemetryObjects(): Promise<void> {
		const channels = new Set<string>();
		for (const def of TELEMETRY_STATES) {
			channels.add(def.id.split('.')[0]);
		}
		for (const channel of channels) {
			await this.setObjectNotExistsAsync(channel, { type: 'channel', common: { name: channel }, native: {} });
		}
		for (const def of TELEMETRY_STATES) {
			await this.setObjectNotExistsAsync(def.id, { type: 'state', common: { ...def.common }, native: {} });
		}
	}

	private async writeTelemetry(product: BluettiUserProduct): Promise<void> {
		await this.writeStateValues({ ...mapDeviceMetadata(product), ...mapTelemetryFields(product) });
	}

	private async writeHealth(health: BluettiPollingHealth): Promise<void> {
		await this.writeStateValues(mapHealth(health));
	}

	private async writeStateValues(values: Record<string, TelemetryValue>): Promise<void> {
		for (const [id, value] of Object.entries(values)) {
			await this.setState(id, value, true);
		}
	}

	private onMessage(message: ioBroker.Message): void {
		void this.handleMessage(message);
	}

	private async handleMessage(message: ioBroker.Message): Promise<void> {
		if (!message.callback) {
			return;
		}

		try {
			switch (message.command) {
				case 'getOAuthStartLink':
					this.sendMessageResponse(message, this.handleGetOAuthStartLink(message.message));
					break;
				case 'oauth2Callback':
					this.sendMessageResponse(message, await this.handleOAuthCallback(message.message));
					break;
				case 'getAuthStatus':
					this.sendMessageResponse(message, this.createAuthStatusResponse());
					break;
				case 'getDevices':
					this.sendMessageResponse(message, await this.handleGetDevices());
					break;
				default:
					this.sendMessageResponse(message, { error: `Unsupported BLUETTI command: ${message.command}` });
			}
		} catch (error) {
			// Do NOT persist the failure into native config here: writing
			// system.adapter.<ns> makes js-controller restart the instance, which drops
			// the in-memory OAuth flow mid-login and breaks the callback (see #32). The
			// error is reported to admin via the message response instead.
			this.log.warn(`BLUETTI message "${message.command}" failed: ${extractSafeErrorMessage(error)}`);
			this.sendMessageResponse(message, { error: extractSafeErrorMessage(error) });
		}
	}

	private handleGetOAuthStartLink(payload: unknown): { openUrl: string; window: string; saveConfig: boolean } {
		const message = readObject(payload);
		const adminOrigin = readRequiredString(message, 'adminOrigin');
		// BLUETTI issues no per-user OAuth clients, so blank fields fall back to the
		// shared default credentials instead of failing the flow (see #34).
		const clientId = readOptionalString(message, 'oauthClientId') ?? BLUETTI_DEFAULT_CLIENT_ID;
		const clientSecret = readOptionalString(message, 'oauthClientSecret') ?? BLUETTI_DEFAULT_CLIENT_SECRET;

		this.oauthFlow = new BluettiOAuthFlow({ clientId });
		this.pendingOAuthCredentials.clear();

		const startLink = this.oauthFlow.createStartLink(adminOrigin, this.namespace);
		this.pendingOAuthCredentials.set(startLink.state, {
			clientId,
			clientSecret,
			callbackUrl: startLink.callbackUrl,
		});
		// The pending login (oauthFlow + pendingOAuthCredentials) lives in process
		// memory and must survive until the OAuth callback returns. Persisting a
		// transient 'authentication_started' status here would write system.adapter.<ns>,
		// which makes js-controller restart the instance and wipe that memory — the
		// callback would then fail with "no pending login" (see #32). So we do not
		// persist during the flow; the admin tracks progress via the sendTo response.

		return createOAuthStartResponse(startLink);
	}

	private async handleOAuthCallback(payload: unknown): Promise<{ result: string }> {
		if (!this.oauthFlow) {
			throw new Error('BLUETTI OAuth callback has no pending login');
		}

		const callback = this.oauthFlow.consumeCallback(readCallbackQuery(payload));
		const pendingCredentials = this.pendingOAuthCredentials.get(callback.state);
		this.pendingOAuthCredentials.delete(callback.state);

		if (!pendingCredentials) {
			throw new Error('BLUETTI OAuth callback credentials are missing or expired');
		}

		const tokenClient = new BluettiOAuthTokenClient({
			clientId: pendingCredentials.clientId,
			clientSecret: pendingCredentials.clientSecret,
		});
		const token = await tokenClient.exchangeAuthorizationCode(callback.code, pendingCredentials.callbackUrl);
		const native = {
			authStatus: 'authenticated',
			oauthLastRefresh: new Date().toISOString(),
			oauthTokenJson: stringifyToken(token),
		} satisfies NativeAuthConfigUpdate;
		await this.persistNativeAuthConfig(native);

		return {
			result: 'authenticated',
		};
	}

	// Builds a token provider over the stored OAuth token, refreshing via the
	// configured client credentials and persisting rotated tokens to native config.
	private createStoredTokenProvider(): BluettiStoredTokenProvider {
		const clientId = this.resolveClientId();
		const clientSecret = this.resolveClientSecret();
		return new BluettiStoredTokenProvider({
			oauthTokenJson: this.config.oauthTokenJson,
			refreshToken: async currentToken => {
				const tokenClient = new BluettiOAuthTokenClient({ clientId, clientSecret });
				return await tokenClient.refreshToken(currentToken.refresh_token ?? '');
			},
			persistToken: async (_token, oauthTokenJson) => {
				await this.persistNativeAuthConfig({
					oauthTokenJson,
					oauthLastRefresh: new Date().toISOString(),
				});
			},
		});
	}

	// Lists the BLUETTI devices bound to the authenticated account for the
	// jsonConfig device selector. Returns an empty list (never an error) so a
	// missing/expired login just yields no options instead of flipping authStatus.
	private async handleGetDevices(): Promise<BluettiDeviceSelectItem[]> {
		try {
			const provider = new BluettiCloudProvider({ tokenProvider: this.createStoredTokenProvider() });
			const products = await provider.getUserProducts();
			return toDeviceSelectItems(products);
		} catch (error) {
			this.log.warn(`BLUETTI device list unavailable: ${extractSafeErrorMessage(error)}`);
			return [];
		}
	}

	private createAuthStatusResponse(): { text: string } {
		return {
			text: this.config.authStatus ?? (this.config.oauthTokenJson ? 'authenticated' : 'not_authenticated'),
		};
	}

	private sendMessageResponse(message: ioBroker.Message, response: unknown): void {
		if (message.callback) {
			this.sendTo(message.from, message.command, response, message.callback);
		}
	}

	private resolveClientId(): string {
		return this.config.oauthClientId?.trim() || BLUETTI_DEFAULT_CLIENT_ID;
	}

	private resolveClientSecret(): string {
		return this.config.oauthClientSecret?.trim() || BLUETTI_DEFAULT_CLIENT_SECRET;
	}

	private async persistNativeAuthConfig(changes: NativeAuthConfigUpdate): Promise<void> {
		const adapterObjectId = `system.adapter.${this.namespace}`;
		const adapterObject = await this.getForeignObjectAsync(adapterObjectId);
		if (!adapterObject) {
			throw new Error(`Cannot find ${adapterObjectId} to persist BLUETTI auth configuration`);
		}

		const currentNative = adapterObject.native ?? {};
		// Writing the adapter object makes js-controller restart the instance. Skip the
		// write when nothing actually changed, otherwise onReady() persists on every start
		// and the instance crash-loops (see #32).
		const hasChanges = (Object.keys(changes) as Array<keyof NativeAuthConfigUpdate>).some(
			key => currentNative[key] !== changes[key],
		);
		if (!hasChanges) {
			return;
		}

		adapterObject.native = {
			...currentNative,
			...changes,
		};
		await this.setForeignObjectAsync(adapterObjectId, adapterObject);
		Object.assign(this.config, changes);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param callback - Callback function
	 */
	private onUnload(callback: () => void): void {
		try {
			this.pollRunner?.stop();
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${extractSafeErrorMessage(error)}`);
			callback();
		}
	}
}

function createOAuthStartResponse(startLink: BluettiOAuthStartLink): {
	openUrl: string;
	window: string;
	saveConfig: boolean;
} {
	return {
		openUrl: startLink.authorizationUrl,
		window: '_blank',
		saveConfig: true,
	};
}

function readCallbackQuery(payload: unknown): Record<string, unknown> {
	const message = readObject(payload);
	const query = message.query;
	return isObject(query) ? query : message;
}

function readObject(value: unknown): Record<string, unknown> {
	if (isObject(value)) {
		return value;
	}

	return {};
}

function readRequiredString(payload: Record<string, unknown>, property: string): string {
	const value = payload[property];
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`Missing BLUETTI OAuth parameter: ${property}`);
	}

	return value.trim();
}

function readOptionalString(payload: Record<string, unknown>, property: string): string | undefined {
	const value = payload[property];
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}

	return value.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function extractSafeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/(code\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(client[_-]?secret\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(access[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/(refresh[_-]?token\s*[:=]\s*)([^\s,;}]+)/gi, '$1<redacted>')
		.replace(/([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g, '<redacted-jwt>');
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Bluetti(options);
} else {
	// otherwise start the instance directly
	(() => new Bluetti())();
}
