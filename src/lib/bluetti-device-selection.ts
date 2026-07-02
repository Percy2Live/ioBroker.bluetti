/* eslint-disable jsdoc/require-jsdoc */

import type { BluettiUserProduct } from './bluetti-cloud-provider';

export interface BluettiDeviceSelectItem {
	label: string;
	value: string;
}

function isOnline(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'online';
}

// Map BLUETTI cloud products to jsonConfig selectSendTo items. Entries without a
// serial number are skipped, since the serial is the value used to poll a device.
export function toDeviceSelectItems(products: readonly BluettiUserProduct[]): BluettiDeviceSelectItem[] {
	return products
		.filter(product => typeof product.sn === 'string' && product.sn.trim() !== '')
		.map(product => {
			const sn = product.sn.trim();
			const name = (product.name ?? '').trim();
			const model = (product.model ?? '').trim();
			const title = name || model || 'BLUETTI device';
			const suffix = isOnline(product.online) ? '' : ' — offline';
			return { label: `${title} (${sn})${suffix}`, value: sn };
		});
}
