import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createCredentialDecryptor, dealerPasswordContext } from '../../src/accounts/credentials.ts';
import type { CredentialDecryptor } from '../../src/accounts/credentials.ts';
import { createAccountRegistry } from '../../src/accounts/registry.ts';
import { encrypt } from '../helpers/credentials.ts';
import { accountDocument, createLogSink, createWorld, dealerHubName, seedDealerAccount, seedPlatformAccount } from '../helpers/world.ts';
import type { World } from '../helpers/world.ts';

describe('account registry (real MongoDB)', () => {
  let world: World;
  before(async () => {
    world = await createWorld();
  });
  after(() => world.drop());
  beforeEach(() => world.reset());

  const build = (hubs: string[], options: { decrypt?: CredentialDecryptor; scanLimit?: number } = {}) => {
    const log = createLogSink();
    const dropped: string[] = [];
    const registry = createAccountRegistry({
      dealers: world.dealers,
      settings: world.settings,
      users: world.users,
      hubs,
      decrypt: options.decrypt ?? createCredentialDecryptor(world.keys.privateKey, world.keys.keyId),
      logger: log.logger,
      onDrop: (hub) => void dropped.push(hub),
      scanLimit: options.scanLimit ?? 100,
    });
    return { registry, log, dropped };
  };

  const states = (log: ReturnType<typeof createLogSink>): Record<string, string> =>
    Object.fromEntries(log.entries().filter((entry) => entry['message'] === 'hub account state').map((entry) => [String(entry['hub']), String(entry['state'])]));

  it('decrypts the allowlisted accounts of the platform and of dealers', async () => {
    const platform = await seedPlatformAccount(world, 'fake', { username: 'Platform-User', password: 'platform-secret', maxPerHour: 40, maxPerYear: null });
    const dealer = await seedDealerAccount(world, 'fake', { username: 'dealer-user', password: 'dealer-secret', maxPerHour: 55, maxPerYear: 10_000 });
    const { registry, log } = build([dealer, platform]);
    assert.deepEqual(registry.hubs(), [], 'nothing is usable before the first refresh');
    await registry.refresh();
    assert.deepEqual(registry.hubs(), [dealer, platform]);
    const account = await registry.get(platform);
    assert.equal(account?.hub, 'fake');
    assert.equal(account?.provider, 'fake');
    assert.equal(account?.username, 'Platform-User');
    assert.equal(account?.password.reveal(), 'platform-secret');
    assert.equal(account?.maxPerHour, 40);
    assert.equal(account?.maxPerYear, null);
    const other = await registry.get(dealer);
    assert.equal(other?.password.reveal(), 'dealer-secret');
    assert.equal(other?.maxPerYear, 10_000);
    assert.deepEqual(states(log), { [dealer]: 'ok', fake: 'ok' });
    assert.doesNotMatch(log.lines.join('\n'), /platform-secret|dealer-secret/);
  });

  it('answers nothing for a hub outside the allowlist and never decrypts the accounts it does not own', async () => {
    const mine = await seedDealerAccount(world, 'fake');
    const foreign = await seedDealerAccount(world, 'fake', { storedPassword: 'garbage' });
    const decrypted: string[] = [];
    const inner = createCredentialDecryptor(world.keys.privateKey, world.keys.keyId);
    const { registry, log } = build([mine], { decrypt: (stored, context) => (decrypted.push(context), inner(stored, context)) });
    await registry.refresh();
    assert.equal(await registry.get(foreign), undefined);
    assert.equal(await registry.get(foreign, { fresh: true }), undefined);
    assert.deepEqual(decrypted, [dealerPasswordContext('fake', mine.split('__')[1] as string)]);
    assert.deepEqual(Object.keys(states(log)), [mine]);
  });

  it('gives a reason code for every unusable account, logged once per change with the hub only', async () => {
    const id = () => new ObjectId();
    const missing = dealerHubName('fake', id());
    const disabled = await seedDealerAccount(world, 'fake', { enabled: false });
    const badShape: string[] = [];
    for (const patch of [{ enabled: 'yes' }, { username: '' }, { username: 'x'.repeat(101) }, { maxPerHour: 0 }, { maxPerHour: 1001 }, { maxPerHour: 1.5 }, { maxPerYear: 0 }, { maxPerYear: 'x' }]) {
      const dealerId = id();
      await world.dealers.insertOne({ _id: dealerId, integrations: { fake: { ...accountDocument(world, 'fake', { dealerId }), ...patch } } });
      badShape.push(dealerHubName('fake', dealerId));
    }
    const notObject = id();
    await world.dealers.insertOne({ _id: notObject, integrations: { fake: 'text' } });
    badShape.push(dealerHubName('fake', notObject));
    const unknownKey = await seedDealerAccount(world, 'fake', { storedPassword: { ...encrypt({ publicKey: world.keys.publicKey, keyId: 'other-key' }, 'p', 'x'), kid: 'other-key' } });
    const oldVersion = await seedDealerAccount(world, 'fake', { storedPassword: { ...encrypt(world.keys, 'p', 'x'), v: 1 } });
    const malformed = await seedDealerAccount(world, 'fake', { storedPassword: 'not-a-credential' });
    const moved = new ObjectId();
    await world.users.insertOne({ _id: moved, role: 'D', status: true });
    await world.dealers.insertOne({ _id: moved, integrations: { fake: { ...accountDocument(world, 'fake', { dealerId: moved }), password: encrypt(world.keys, 'p', dealerPasswordContext('fake', new ObjectId().toHexString())) } } });

    const hubs = [missing, disabled, ...badShape, unknownKey, oldVersion, malformed, dealerHubName('fake', moved)];
    const { registry, log } = build(hubs);
    await registry.refresh();
    await registry.refresh();
    assert.deepEqual(registry.hubs(), []);
    const result = states(log);
    assert.equal(result[missing], 'missing');
    assert.equal(result[disabled], 'disabled');
    assert.deepEqual(badShape.map((hub) => result[hub]), badShape.map(() => 'invalid_account'));
    assert.equal(result[unknownKey], 'unknown_key');
    assert.equal(result[oldVersion], 'unsupported_version');
    assert.equal(result[malformed], 'malformed');
    assert.equal(result[dealerHubName('fake', moved)], 'authentication');
    assert.equal(log.messages().filter((message) => message === 'hub account state').length, hubs.length, 'one line per hub for two refreshes');
    const levels = Object.fromEntries(log.entries().map((entry) => [String(entry['hub']), entry['level']]));
    assert.equal(levels[missing], 'info');
    assert.equal(levels[disabled], 'info');
    assert.equal(levels[unknownKey], 'warn');
  });

  it('disables both hubs that share a username, ignoring case, even when only one is allowlisted', async () => {
    const a = await seedDealerAccount(world, 'fake', { username: 'Shared-User' });
    const b = await seedDealerAccount(world, 'fake', { username: 'shared-user' });
    const c = await seedDealerAccount(world, 'fake', { username: 'unique' });
    const platform = await seedPlatformAccount(world, 'fake', { username: 'SHARED-USER' });
    const { registry, log } = build([a, c]);
    await registry.refresh();
    assert.deepEqual(registry.hubs(), [c]);
    assert.equal(states(log)[a], 'duplicate_username');
    assert.equal(states(log)[c], 'ok');
    void b;
    void platform;
  });

  it('compares usernames trimmed, NFKC-normalised and in lower case (look-alikes are one login)', async () => {
    const a = await seedDealerAccount(world, 'fake', { username: 'admin' });
    await seedDealerAccount(world, 'fake', { username: ' \uFF21dmin ' });
    const { registry, log } = build([a]);
    await registry.refresh();
    assert.deepEqual(registry.hubs(), []);
    assert.equal(states(log)[a], 'duplicate_username');
  });

  describe('the state of the dealer (its linked user, same _id)', () => {
    const setUser = async (hub: string, user: Document | null): Promise<void> => {
      const id = new ObjectId(hub.split('__')[1] as string);
      await world.users.deleteMany({ _id: id });
      if (user !== null) {
        await world.users.insertOne({ _id: id, ...user });
      }
    };

    it('stops the hub of a dealer that is disabled, in the trash or missing, whatever the account says', async () => {
      const cases: Array<[string, Document | null]> = [
        ['dealer_disabled', { status: false, trash: false }],
        ['dealer_disabled', { trash: false }],
        ['dealer_disabled', { status: 'yes' }],
        ['dealer_trashed', { status: true, trash: true }],
        ['dealer_trashed', { status: false, trash: true }],
        ['dealer_missing', null],
      ];
      const hubs: string[] = [];
      for (const [, user] of cases) {
        const hub = await seedDealerAccount(world, 'fake', { enabled: true });
        await setUser(hub, user);
        hubs.push(hub);
      }
      const active = await seedDealerAccount(world, 'fake');
      const platform = await seedPlatformAccount(world, 'fake', { username: 'platform' });
      const { registry, log } = build([...hubs, active, platform]);
      await registry.refresh();
      assert.deepEqual(registry.hubs(), [active, platform], 'the platform has no dealer; an active dealer works');
      const result = states(log);
      assert.deepEqual(hubs.map((hub) => result[hub]), cases.map(([reason]) => reason));
      assert.equal(log.entries().find((entry) => entry['hub'] === hubs[0])?.['level'], 'warn');
    });

    it('is read again on the fresh read after a claim: a dealer disabled or trashed meanwhile stops, and the adapter forgets it', async () => {
      const hub = await seedDealerAccount(world, 'fake');
      const { registry, dropped, log } = build([hub]);
      await registry.refresh();
      assert.ok(await registry.get(hub, { fresh: true }));
      await world.users.updateOne({ _id: new ObjectId(hub.split('__')[1] as string) }, { $set: { trash: true } });
      assert.equal(await registry.get(hub, { fresh: true }), undefined);
      assert.deepEqual(dropped, [hub]);
      assert.equal(states(log)[hub], 'dealer_trashed');
      await world.users.updateOne({ _id: new ObjectId(hub.split('__')[1] as string) }, { $set: { trash: false } });
      assert.ok(await registry.get(hub, { fresh: true }), 'back in business');
      await world.users.deleteMany({});
      assert.equal(await registry.get(hub, { fresh: true }), undefined);
      assert.equal(states(log)[hub], 'dealer_missing');
    });

    it('reads only the status and trash fields of the user', async () => {
      const hub = await seedDealerAccount(world, 'fake');
      await world.users.updateOne({ _id: new ObjectId(hub.split('__')[1] as string) }, { $set: { password: 'legacy-hash', email: 'private@example.com' } });
      const { registry, log } = build([hub]);
      await registry.refresh();
      assert.ok(await registry.get(hub, { fresh: true }));
      assert.doesNotMatch(log.lines.join('\n'), /legacy-hash|private@example/);
    });
  });

  it('does not count a disabled account as a second use of the username', async () => {
    const a = await seedDealerAccount(world, 'fake', { username: 'same' });
    await seedDealerAccount(world, 'fake', { username: 'same', enabled: false });
    const { registry } = build([a]);
    await registry.refresh();
    assert.deepEqual(registry.hubs(), [a]);
  });

  it('re-reads one hub on demand and tells the adapter to forget it when it stopped being usable or changed', async () => {
    const id = new ObjectId();
    const hub = await seedDealerAccount(world, 'fake', { username: 'u1', password: 'p1' }, id);
    const { registry, dropped, log } = build([hub]);
    await registry.refresh();
    assert.equal((await registry.get(hub, { fresh: true }))?.password.reveal(), 'p1');
    assert.deepEqual(dropped, [], 'unchanged: nothing to forget');

    await seedDealerAccount(world, 'fake', { username: 'u1', password: 'p2' }, id);
    assert.equal((await registry.get(hub))?.password.reveal(), 'p1', 'a plain get uses the last refresh');
    assert.equal((await registry.get(hub, { fresh: true }))?.password.reveal(), 'p2');
    assert.deepEqual(dropped, [hub], 'a changed password');

    await seedDealerAccount(world, 'fake', { username: 'u2', password: 'p2' }, id);
    await registry.get(hub, { fresh: true });
    assert.deepEqual(dropped, [hub, hub], 'a changed username');

    await seedDealerAccount(world, 'fake', { username: 'u2', password: 'p2', enabled: false }, id);
    assert.equal(await registry.get(hub, { fresh: true }), undefined);
    assert.deepEqual(dropped, [hub, hub, hub], 'disabled');
    assert.deepEqual(registry.hubs(), []);
    await registry.get(hub, { fresh: true });
    assert.equal(dropped.length, 3, 'already unusable: nothing more to forget');

    await world.dealers.deleteMany({});
    assert.equal(await registry.get(hub, { fresh: true }), undefined, 'removed');
    assert.equal(states(log)[hub], 'missing');
    assert.doesNotMatch(log.lines.join('\n'), /p1|p2/);
  });

  it('re-reads the platform account on demand', async () => {
    const hub = await seedPlatformAccount(world, 'fake', { password: 'first' });
    const { registry, dropped } = build([hub]);
    await registry.refresh();
    await seedPlatformAccount(world, 'fake', { password: 'second' });
    assert.equal((await registry.get(hub, { fresh: true }))?.password.reveal(), 'second');
    assert.deepEqual(dropped, [hub]);
    await world.settings.updateOne({ key: 'INTEGRATIONS' }, { $unset: { 'value.fake': '' } });
    assert.equal(await registry.get(hub, { fresh: true }), undefined);
    await world.settings.deleteMany({});
    assert.equal(await registry.get(hub, { fresh: true }), undefined, 'no settings document at all');
    await world.settings.insertOne({ key: 'INTEGRATIONS', value: 'text' });
    await registry.refresh();
    assert.equal(await registry.get(hub), undefined, 'a value that is not an object');
  });

  it('a fresh read sees a username that another hub took in the meantime', async () => {
    const a = await seedDealerAccount(world, 'fake', { username: 'one' });
    const idB = new ObjectId();
    const b = await seedDealerAccount(world, 'fake', { username: 'two' }, idB);
    const { registry } = build([a, b]);
    await registry.refresh();
    assert.deepEqual(registry.hubs(), [a, b]);
    await seedDealerAccount(world, 'fake', { username: 'ONE' }, idB);
    assert.equal(await registry.get(b, { fresh: true }), undefined);
    assert.deepEqual(registry.hubs(), [a], 'the first hub is disabled at its own next read');
  });

  it('reads only the accounts of the providers of the allowlist, skips ids that are not ObjectIds and warns at the scan limit', async () => {
    const hub = await seedDealerAccount(world, 'fake');
    await seedDealerAccount(world, 'fake');
    await seedDealerAccount(world, 'fake');
    await world.dealers.insertOne({ _id: 'legacy-string-id' as never, integrations: { fake: accountDocument(world, 'fake', {}) } });
    await seedDealerAccount(world, 'other');
    const { registry, log } = build([hub], { scanLimit: 2 });
    await registry.refresh();
    assert.ok(log.messages('warn').includes('too many accounts to read: the shared-username check is incomplete'));
    const wide = build([hub], { scanLimit: 100 });
    await wide.registry.refresh();
    assert.equal(wide.log.messages('warn').length, 0);
    assert.deepEqual(wide.registry.hubs(), [hub]);
  });

  it('works with several providers in one allowlist', async () => {
    const a = await seedDealerAccount(world, 'fake');
    const b = await seedDealerAccount(world, 'other');
    const { registry } = build([a, b]);
    await registry.refresh();
    assert.deepEqual(registry.hubs(), [a, b]);
  });
});
