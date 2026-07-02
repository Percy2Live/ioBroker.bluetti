import { expect } from 'chai';

// Mocha imports TypeScript test files as ESM in this scaffold; the explicit .ts
// suffix is needed at runtime, while the main tsc config does not enable it.
// @ts-expect-error Runtime import resolved by ts-node.
import { toDeviceSelectItems } from './bluetti-device-selection.ts';

describe('toDeviceSelectItems', () => {
	it('maps products to label/value pairs using name and serial', () => {
		const items = toDeviceSelectItems([
			{ sn: 'SN123', name: 'Wohnzimmer', model: 'EP600', online: '1', stateList: [] },
		]);
		expect(items).to.deep.equal([{ label: 'Wohnzimmer (SN123)', value: 'SN123' }]);
	});

	it('falls back to model, then to a generic label', () => {
		const items = toDeviceSelectItems([
			{ sn: 'A', model: 'EP600', online: 'true', stateList: [] },
			{ sn: 'B', online: '1', stateList: [] },
		]);
		expect(items[0].label).to.equal('EP600 (A)');
		expect(items[1].label).to.equal('BLUETTI device (B)');
	});

	it('marks offline devices', () => {
		const [item] = toDeviceSelectItems([{ sn: 'X', name: 'Keller', online: '0', stateList: [] }]);
		expect(item.label).to.equal('Keller (X) — offline');
	});

	it('trims serials and skips entries without one', () => {
		const items = toDeviceSelectItems([
			{ sn: '', name: 'ghost', online: '1', stateList: [] },
			{ sn: '   ', name: 'blank', online: '1', stateList: [] },
			{ sn: ' ok ', name: 'real', online: '1', stateList: [] },
		]);
		expect(items).to.deep.equal([{ label: 'real (ok)', value: 'ok' }]);
	});
});
