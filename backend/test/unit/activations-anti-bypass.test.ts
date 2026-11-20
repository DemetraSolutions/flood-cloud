import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { ObjectId } from 'mongodb';
import { GROUP_PROJECTION } from '../../src/modules/activations/activations.repository.ts';
import { MIRROR_FIELDS, MIRROR_LEAVES, trustedGroupMirror } from '../../src/shared/security/scope/group-mirror.ts';
import { ACTIVATION_COMPANY_PROJECTION, ACTIVATION_PLACE_PROJECTION, ACTIVATION_PROVIDERS } from '../../src/shared/security/scope/mirror-activations.ts';
import { isPublicPermission } from '../../src/shared/security/rbac/public-permissions.ts';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []))))).flat();
}

describe('what the activations read of the copies', () => {
  it('never projects a container that holds credentials as a whole: only the allowlisted fields and the exact leaves', () => {
    for (const [name, projection] of [['places', ACTIVATION_PLACE_PROJECTION], ['companies', ACTIVATION_COMPANY_PROJECTION]] as const) {
      for (const field of Object.keys(projection)) {
        assert.ok(field === 'groupId' || MIRROR_FIELDS[name].has(field) || MIRROR_LEAVES[name].has(field), `${name}.${field} is not in the central allowlist`);
        assert.ok(!['integrations', 'devices', 'roomsSettings', 'tgm', 'fattura_elettronica', 'settings', 'banks', 'server', 'platform'].includes(field), field);
      }
    }
    assert.deepEqual([...MIRROR_LEAVES.companies], ['fattura_elettronica.hub']);
    const expected = ['devices.type', ...ACTIVATION_PROVIDERS.map((provider) => `integrations.${provider}.status`), 'roomsSettings.reservation.status', 'roomsSettings.reservation.webWidget.status', 'tgm.status'];
    assert.deepEqual([...MIRROR_LEAVES.places].sort(), [...expected].sort());
    assert.deepEqual([...ACTIVATION_PROVIDERS], ['floodPay', 'reserveWithGoogle', 'bizerba', 'qodeup', 'googleMaps', 'yellgo', 'leggimenu', 'plateform', 'cooperto', 'tomatoai', 'keenon', 'phlex']);
  });

  it('keeps the credentials out of the per-group reads: a leaf can be read, the container it is in cannot', async () => {
    const cursor = { sort: () => cursor, toArray: async () => [] };
    const mirror = trustedGroupMirror(new ObjectId(), { common: () => ({ collection: () => ({ find: () => cursor }) }) } as never, 'places');
    for (const projection of [{ integrations: 1 }, { devices: 1 }, { roomsSettings: 1 }, { 'integrations.floodPay': 1 }, { 'integrations.floodPay.apiKey': 1 }, { 'devices.type.x': 1 }]) {
      await assert.rejects(mirror.find({}, { projection: projection as never, limit: 1 }), /allowlist projection/);
    }
    for (const filter of [{ integrations: { $exists: true } }, { 'integrations.dojo.status': true }, { 'integrations.floodPay.apiKey': 'x' }, { $expr: { $eq: ['$integrations.floodPay', true] } }]) {
      await assert.rejects(mirror.find(filter, { projection: { name: 1 }, limit: 1 }), /not readable|Reference to a field/);
    }
    assert.deepEqual(await mirror.find({ 'integrations.floodPay.status': true }, { projection: { 'integrations.floodPay.status': 1, 'devices.type': 1 }, limit: 1, sort: { 'tgm.status': 1 } }), []);
    await assert.rejects(mirror.find({}, { projection: { name: 1 }, limit: 1, sort: { 'integrations.floodPay.apiKey': 1 } }), /sort/);
  });

  it('does not let the MultiSafepay credentials, nor the other new fields of a place, be read through the copies, and keeps the provider out of the activations', async () => {
    const cursor = { sort: () => cursor, toArray: async () => [] };
    const mirror = trustedGroupMirror(new ObjectId(), { common: () => ({ collection: () => ({ find: () => cursor }) }) } as never, 'places');
    const hidden = ['integrations.multisafepay', 'integrations.multisafepay.terminalGroupApiKey', 'integrations.multisafepay.websiteApiKey', 'integrations.multisafepay.status', 'devices.multisafepayTerminals', 'roomsSettings.discountReasons', 'roomsSettings.tableIdleMinutes'];
    for (const field of hidden) {
      await assert.rejects(mirror.find({}, { projection: { [field]: 1 } as never, limit: 1 }), /allowlist projection/, field);
      await assert.rejects(mirror.find({ [field]: 'x' }, { projection: { name: 1 }, limit: 1 }), /not readable/, field);
      await assert.rejects(mirror.find({}, { projection: { name: 1 }, limit: 1, sort: { [field]: 1 } }), /sort/, field);
    }
    await assert.rejects(mirror.find({ $expr: { $eq: ['$integrations.multisafepay.websiteApiKey', 'x'] } }, { projection: { name: 1 }, limit: 1 }), /Reference to a field/);
    assert.ok(!ACTIVATION_PROVIDERS.includes('multisafepay'));
    assert.ok(![...Object.keys(ACTIVATION_PLACE_PROJECTION)].some((field) => /multisafepay/i.test(field)));
  });

  it('reads the groups with a projection that holds no key, host or setting of a group but the two switches', () => {
    assert.deepEqual(Object.keys(GROUP_PROJECTION).sort(), ['dealerId', 'name', 'settings.integrations.statmanager.status', 'settings.tobaccosGamesMonopoly', 'status']);
  });

  it('opens the fixed readers of the activations only from the activations repository, and exposes the permissions on /v1 only', async () => {
    const importers: string[] = [];
    for (const file of await filesUnder(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (path !== 'shared/security/scope/group-mirror.ts' && /\b(readMirrorActivationPlaces|readMirrorActivationCompanies)\b/.test(await readFile(file, 'utf8'))) {
        importers.push(path);
      }
      if (path.startsWith('modules/public-api/')) {
        assert.ok(!/activations|billingClosures|priceOverrides|settings\/price-list/i.test(await readFile(file, 'utf8')), path);
      }
    }
    assert.deepEqual(importers, ['modules/activations/activations.repository.ts']);
    assert.equal(isPublicPermission('activations:read'), false);
    assert.equal(isPublicPermission('activations:manage'), false);
  });
});
