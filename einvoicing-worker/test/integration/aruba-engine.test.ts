import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Document } from 'mongodb';
import { createArubaAdapter } from '../../src/providers/aruba/adapter.ts';
import type { ProviderAdapter } from '../../src/providers/types.ts';
import { startFakeAruba, tokenReply } from '../helpers/fake-aruba.ts';
import type { FakeAruba } from '../helpers/fake-aruba.ts';
import { createRig, groupStatusOf, queueRecordOf, SELLER_A, SELLER_B, sellerFields, seedPlatformAccount, seedRecord, T0 } from '../helpers/world.ts';
import type { Rig } from '../helpers/world.ts';
import { createWorld } from '../helpers/world.ts';
import type { World } from '../helpers/world.ts';

const MINUTE = 60_000;
const SIGNIN = 'POST /auth/signin';
const UPLOAD = 'POST /services/invoice/upload';
const DETAIL = 'GET /api/v2/invoices-out/detail';
const NOTIFICATIONS = 'GET /api/v2/invoices-out/notifications';
const SEARCH = 'GET /api/v2/invoices-out';
const NAME = 'IT01234567890_00001.xml';

describe('Aruba adapter in the queue engine (real MongoDB, fake Aruba)', () => {
  let world: World;
  let fake: FakeAruba;
  before(async () => {
    world = await createWorld();
  });
  after(() => world.drop());
  beforeEach(async () => {
    await world.reset();
    fake = await startFakeAruba();
    fake.route(SIGNIN, tokenReply());
  });
  afterEach(() => fake.close());

  /** The engine with the real Aruba adapter pointed at the fake. */
  const setup = async (timeouts = { upload: 400, request: 400 }): Promise<Rig> => {
    await seedPlatformAccount(world, 'aruba', { username: 'platform-user', password: 'platform-secret' });
    const adapters = new Map<string, ProviderAdapter>();
    const rig = createRig(world, { hubs: ['aruba'], adapters });
    adapters.set('aruba', createArubaAdapter({ environment: 'demo', registry: rig.registry, limiters: rig.limiters, logger: rig.log.logger, clock: rig.clock.now, sleep: rig.clock.sleep, hosts: fake.hosts, timeouts }));
    return rig;
  };
  const workerOf = async (record: Document): Promise<Document> => ((await queueRecordOf(world, record)) as Document)['worker'] as Document;

  it('queue record, validated XML, upload accepted, status Consegnata: the record is deleted and the group document says delivered', async () => {
    const rig = await setup();
    const record = await seedRecord(world, 'aruba');
    fake.route(UPLOAD, { json: { errorCode: '0000', errorDescription: '', uploadFileName: NAME } });
    await rig.round();

    const [hit] = fake.hits(UPLOAD);
    const xml = Buffer.from(JSON.parse(hit?.body ?? '{}').dataFile as string, 'base64').toString('utf8');
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<p:FatturaElettronica /);
    assert.match(xml, /<IdCodice>01879020517<\/IdCodice>/, 'Aruba PEC is the transmitter');
    assert.equal(hit?.headers['authorization'], 'Bearer access-token-1');
    const stored = (await queueRecordOf(world, record)) as Document;
    assert.deepEqual([stored['sent'], stored['hubId']], [true, NAME]);
    assert.equal((await workerOf(record))['state'], 'uploaded');
    assert.equal(fake.hits(SIGNIN).length, 1);

    fake.route(DETAIL, { json: { filename: NAME, invoices: [{ status: 'Consegnata' }], sdiErrors: [] } });
    rig.clock.advance(3 * MINUTE);
    await rig.round();
    assert.equal(fake.hits(DETAIL)[0]?.rawQuery, `filename=${NAME}&includeFile=false`);
    assert.equal(await queueRecordOf(world, record), null, 'a delivered private invoice leaves the queue');
    assert.equal(await groupStatusOf(world, record), 'delivered');
    assert.equal(fake.hits(SIGNIN).length, 1, 'the token was reused');
    assert.doesNotMatch(rig.log.lines.join('\n'), /platform-secret|access-token|<p:Fattura|dataFile/);
  });

  it('a discard is kept with the reasons of the SdI notification', async () => {
    const rig = await setup();
    const record = await seedRecord(world, 'aruba');
    fake.route(UPLOAD, { json: { errorCode: '0000', uploadFileName: NAME } });
    await rig.round();
    fake.route(DETAIL, { json: { filename: NAME, invoices: [{ status: 'Scartata' }], sdiErrors: [] } });
    const ns = '<NotificaScarto><ListaErrori><Errore><Codice>00404</Codice><Descrizione>Fattura duplicata</Descrizione></Errore></ListaErrori></NotificaScarto>';
    fake.route(NOTIFICATIONS, { json: { notifications: [{ docType: 'NS', file: Buffer.from(ns).toString('base64') }] } });
    rig.clock.advance(3 * MINUTE);
    await rig.round();
    const stored = (await queueRecordOf(world, record)) as Document;
    assert.equal(stored['sendStatus'], 'rejected');
    assert.deepEqual((await workerOf(record))['sdiErrors'], [{ code: '00404', description: 'Fattura duplicata' }]);
    assert.match(stored['error'].errorDescription, /00404 Fattura duplicata/);
  });

  it('a timeout after the request left is looked up in Aruba before any new upload: found, so never sent twice', async () => {
    const rig = await setup({ upload: 150, request: 400 });
    const record = await seedRecord(world, 'aruba');
    fake.route(UPLOAD, { hang: true });
    await rig.round();
    assert.equal((await workerOf(record))['state'], 'uploading');
    assert.equal(fake.hits(UPLOAD).length, 1);

    fake.route(SEARCH, { json: { content: [{ filename: NAME, invoices: [{ number: '42', invoiceDate: '2026-11-27', docType: 'TD01' }] }], last: true } });
    rig.clock.advance(6 * MINUTE);
    await rig.round();
    assert.equal(fake.hits(UPLOAD).length, 1, 'not uploaded again');
    const [search] = fake.hits(SEARCH);
    assert.equal(search?.query.get('senderVatcode'), SELLER_A);
    assert.equal(search?.query.get('creationStartDate'), new Date(T0 - 60 * MINUTE).toISOString(), 'one hour before the first attempt');
    assert.equal(((await queueRecordOf(world, record)) as Document)['hubId'], NAME);
  });

  it('a tier limit on one seller pauses that seller only; a second seller in a row backs the whole account off', async () => {
    const rig = await setup();
    const first = await seedRecord(world, 'aruba');
    const second = await seedRecord(world, 'aruba', { number: 43, ...sellerFields(SELLER_B) });
    fake.route(UPLOAD, { status: 429 });
    await rig.round();
    assert.equal(fake.hits(UPLOAD).length, 1);
    assert.equal(((await workerOf(first))['nextAttemptAt'] as Date).getTime() - T0 >= 62 * MINUTE, true, 'the first seller waits 62 minutes');
    rig.clock.advance(70_000);
    await rig.round();
    assert.equal(fake.hits(UPLOAD).length, 2, 'the other seller is not held back by the first one');
    const secondWait = ((await workerOf(second))['nextAttemptAt'] as Date).getTime() - (T0 + 70_000);
    assert.ok(secondWait >= 10 * MINUTE && secondWait < 62 * MINUTE, 'the account backs off in steps, from ten minutes');
    assert.ok(rig.log.messages('warn').includes('two different sellers were limited in a row: the account backs off'));
  });

  it('a status check delayed by the notifications limiter only delays that check: the upload backoff of the account is untouched', async () => {
    const rig = await setup();
    const record = await seedRecord(world, 'aruba');
    fake.route(UPLOAD, { json: { errorCode: '0000', uploadFileName: NAME } });
    await rig.round();
    fake.route(DETAIL, { json: { filename: NAME, invoices: [{ status: 'Scartata' }], sdiErrors: [] } });
    await rig.limiters.coolDown('ip:aruba:notifications', rig.clock.now() + 3 * MINUTE + 5 * MINUTE);
    rig.clock.advance(3 * MINUTE);
    await rig.round();
    const worker = await workerOf(record);
    assert.equal(worker['state'], 'uploaded', 'still being polled');
    assert.equal(worker['lastCode'], 'NOTIFICATIONS_LIMITED');
    assert.ok((worker['nextStatusAt'] as Date).getTime() > rig.clock.now() + 4 * MINUTE);
    assert.equal(fake.hits(NOTIFICATIONS).length, 0);
    const upload = await world.limits.findOne({ _id: 'account:aruba:upload' });
    assert.equal(upload?.step, 0, 'no backoff step on the upload key');
    assert.equal(upload?.until.getTime(), 0);
    assert.ok(((await world.limits.findOne({ _id: 'account:aruba:status' }))?.until.getTime() ?? 0) > rig.clock.now());
  });
});
