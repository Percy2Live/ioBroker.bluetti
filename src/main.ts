/*
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import { BluettiCloudProvider } from './lib/bluetti-cloud-provider';
import { toDeviceSelectItems, type BluettiDeviceSelectItem } from './lib/bluetti-device-selection';
import { BluettiOAuthFlow, type BluettiOAuthStartLink } from './lib/bluetti-oauth-flow';
import { BluettiOAuthTokenClient } from './lib/bluetti-oauth-token-client';
import { BluettiStoredTokenProvider, stringifyToken } from './lib/bluetti-stored-token-provider';

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

		this.log.info(`BLUETTI adapter scaffold ready; poll interval: ${this.config.pollInterval} seconds`);
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
					this.sendMessageResponse(message, await this.handleGetOAuthStartLink(message.message));
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
			await this.persistNativeAuthConfig({ authStatus: 'auth_failed' });
			this.sendMessageResponse(message, { error: extractSafeErrorMessage(error) });
		}
	}

	private async handleGetOAuthStartLink(
		payload: unknown,
	): Promise<{ openUrl: string; window: string; saveConfig: boolean }> {
		const message = readObject(payload);
		const adminOrigin = readRequiredString(message, 'adminOrigin');
		const clientId = readRequiredString(message, 'oauthClientId');
		const clientSecret = readRequiredString(message, 'oauthClientSecret');

		this.oauthFlow = new BluettiOAuthFlow({ clientId });
		this.pendingOAuthCredentials.clear();

		const startLink = this.oauthFlow.createStartLink(adminOrigin, this.namespace);
		this.pendingOAuthCredentials.set(startLink.state, {
			clientId,
			clientSecret,
			callbackUrl: startLink.callbackUrl,
		});
		await this.persistNativeAuthConfig({ authStatus: 'authentication_started' });

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

	// Lists the BLUETTI devices bound to the authenticated account for the
	// jsonConfig device selector. Returns an empty list (never an error) so a
	// missing/expired login just yields no options instead of flipping authStatus.
	private async handleGetDevices(): Promise<BluettiDeviceSelectItem[]> {
		const clientId = this.config.oauthClientId ?? '';
		const clientSecret = this.config.oauthClientSecret ?? '';

		const tokenProvider = new BluettiStoredTokenProvider({
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

		try {
			const provider = new BluettiCloudProvider({ tokenProvider });
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
