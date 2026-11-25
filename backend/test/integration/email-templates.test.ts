import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { createEmailTemplatesRepository } from '../../src/modules/email-templates/email-templates.repository.ts';
import { findPlacesUsingTemplate } from '../../src/shared/security/scope/group-mirror.ts';
import { accessFor } from '../helpers/group-access.ts';
import { principalOf } from '../helpers/principal.ts';
import { MAX_TEMPLATE_HTML_BYTES, MAX_TEMPLATE_TEXT_BYTES } from '../../src/modules/email-templates/email-templates.schemas.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const dealer = () => world.office.cluster.dealerA;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/email-templates`;
const one = (id: string, index = 0) => `${base(index)}/${id}`;
const store = () => ctx.databases.group(world.group(0).groupId, 'cluster0').collection('email_templates');
const tag = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const SECRET = 'SECRET-HTML-MARKER-7f3a';
const html = `<html><body><p>${SECRET}</p></body></html>`;

async function create(body: Document = { name: 'Conferma', text: 'ciao', html }, actor = sa()) {
  const reply = await call(actor, 'POST', base(), body);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply;
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { 'settings.email': true } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('e-mail templates: access', () => {
  it('answers 403 FEATURE_DISABLED to every role when the group has no e-mail feature, for every route', async () => {
    const id = hex(new ObjectId());
    for (const actor of [psa(), dealer(), world.group(1).sa]) {
      for (const [method, path, body, headers] of [
        ['GET', base(1), undefined, undefined],
        ['GET', one(id, 1), undefined, undefined],
        ['POST', base(1), { name: 'x' }, undefined],
        ['PATCH', one(id, 1), { name: 'x' }, { 'if-match': `"${'a'.repeat(43)}"` }],
        ['DELETE', one(id, 1), undefined, undefined],
      ] as const) {
        assert.deepEqual(failure(await call(actor, method, path, body, headers ? { ...headers } : undefined)), { status: 403, code: 'FEATURE_DISABLED', details: undefined }, `${method} ${path}`);
      }
    }
  });

  it('lets PSA, dealer, SA, CA and PA read and write, and refuses the employee, an unauthenticated caller and other groups', async () => {
    const created = await create();
    const id = created.body.data.id as string;
    for (const actor of [psa(), dealer(), sa(), ca(), pa()]) {
      assert.equal((await call(actor, 'GET', base())).status, 200);
      assert.equal((await call(actor, 'GET', one(id))).status, 200);
      const other = await call(actor, 'POST', base(), { name: 'Di ruolo' });
      assert.equal(other.status, 201);
      const current = await call(actor, 'GET', one(other.body.data.id));
      assert.equal((await call(actor, 'PATCH', one(other.body.data.id), { name: 'Rinominato' }, { 'if-match': tag(current) })).status, 200);
      assert.equal((await call(actor, 'DELETE', one(other.body.data.id))).status, 204);
    }
    // An employee cannot even sign in; a user without the permission to read places is refused.
    const blind = await addUser(ctx, world.office, { permissions: { status: true, places: { r: false, w: false } } });
    assert.equal(failure(await call(blind.id, 'GET', base())).status, 403);
    assert.equal(failure(await call(blind.id, 'POST', base(), { name: 'x' })).status, 403);
    assert.equal(failure(await call(blind.id, 'DELETE', one(id))).status, 403);
    assert.equal((await world.office.call('GET', base(), undefined)).status, 401);
    // Another dealer's and another group's users do not reach this group.
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', base())).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', base())).status, 404);
    // A user who may read but not update places can read and not write.
    const reader = await addUser(ctx, world.office, { permissions: { status: true, places: { r: true, w: false } } });
    assert.equal((await call(reader.id, 'GET', base())).status, 200);
    assert.equal(failure(await call(reader.id, 'POST', base(), { name: 'x' })).status, 403);
    assert.equal(failure(await call(reader.id, 'PATCH', one(id), { name: 'x' }, { 'if-match': tag(created) })).status, 403);
    assert.equal(failure(await call(reader.id, 'DELETE', one(id))).status, 403);
  });

  it('keeps the templates of the groups apart', async () => {
    const created = await create({ name: 'Solo gruppo zero' });
    // The same id asked through another group the caller reaches (the second group has the feature too): not found.
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $set: { 'settings.email': true } });
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(created.body.data.id, 1))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'DELETE', one(created.body.data.id, 1))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'PATCH', one(created.body.data.id, 1), { name: 'x' }, { 'if-match': tag(created) })).status, 404);
    assert.deepEqual((await call(world.group(1).sa, 'GET', base(1))).body.data, []);
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $unset: { 'settings.email': '' } });
  });
});

describe('e-mail templates: reads', () => {
  it('lists id, name and date only, never the content, sorted and searched by name, in pages', async () => {
    await store().deleteMany({});
    const names = ['Zeta', 'Alfa', 'Beta', 'Gamma'];
    for (const name of names) {
      await create({ name, text: `testo ${SECRET}`, html });
    }
    await store().insertMany([{ _id: new ObjectId(), name: 5, text: 3, html: null }, { _id: new ObjectId(), text: 'senza nome' }]);
    const reply = await call(sa(), 'GET', base());
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.data.map((item: { name: string }) => item.name), ['', '', 'Alfa', 'Beta', 'Gamma', 'Zeta']);
    for (const item of reply.body.data) {
      assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'updatedAt']);
    }
    assert.equal(reply.body.data[0].updatedAt, null);
    assert.ok(!JSON.stringify(reply.body).includes(SECRET));
    assert.deepEqual((await call(sa(), 'GET', `${base()}?q=ET`)).body.data.map((item: { name: string }) => item.name), ['Beta', 'Zeta']);
    assert.deepEqual((await call(sa(), 'GET', `${base()}?q=${encodeURIComponent(SECRET)}`)).body.data, []);
    const seen: string[] = [];
    let url = `${base()}?limit=2&sort=-name`;
    for (let page = 0; page < 6; page += 1) {
      const next = await call(sa(), 'GET', url);
      seen.push(...next.body.data.map((item: { name: string }) => item.name));
      if (next.body.page.next === null) {
        break;
      }
      url = `${base()}?limit=2&sort=-name&cursor=${next.body.page.next as string}`;
    }
    assert.deepEqual(seen, ['Zeta', 'Gamma', 'Beta', 'Alfa', '', '']);
    assert.equal((await call(sa(), 'GET', `${base()}?sort=-updatedAt`)).status, 200);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?limit=101`)).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?cursor=nope`)).status, 422);
  });

  it('gets one template with its content as JSON and an ETag, and answers 404 for an unknown or malformed id', async () => {
    const created = await create({ name: 'Uno', text: 'testo', html });
    const reply = await call(sa(), 'GET', one(created.body.data.id));
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-type')!, /^application\/json/);
    assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Object.keys(reply.body.data).sort(), ['createdAt', 'html', 'id', 'name', 'text', 'updatedAt']);
    assert.equal(reply.body.data.html, html);
    assert.equal(tag(reply), tag(created));
    assert.equal(failure(await call(sa(), 'GET', one(hex(new ObjectId())))).status, 404);
    assert.equal(failure(await call(sa(), 'GET', one('not-an-id'))).status, 422);
    const legacy = new ObjectId();
    await store().insertOne({ _id: legacy, name: 'Legacy', text: 4, html: undefined });
    const legacyReply = await call(sa(), 'GET', one(hex(legacy)));
    assert.deepEqual([legacyReply.body.data.text, legacyReply.body.data.html, legacyReply.body.data.createdAt, legacyReply.body.data.updatedAt], ['', '', null, null]);
  });
});

describe('e-mail templates: creation', () => {
  it('creates a template with 201, Location, ETag and the document of the legacy shape, and replays an idempotent retry', async () => {
    const key = randomUUID();
    const first = await call(sa(), 'POST', base(), { name: '  Nome  ', text: 'testo', html }, { 'idempotency-key': key });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.name, 'Nome');
    assert.equal(first.headers.get('location'), `/v1${base()}/${first.body.data.id as string}`);
    const stored = await store().findOne({ _id: new ObjectId(first.body.data.id as string) });
    assert.deepEqual(Object.keys(stored!).sort(), ['_id', 'html', 'insertDate', 'name', 'text', 'updateDate']);
    assert.ok(stored!['insertDate'] instanceof Date && stored!['updateDate'] instanceof Date);
    const replay = await call(sa(), 'POST', base(), { name: '  Nome  ', text: 'testo', html }, { 'idempotency-key': key });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data.id, first.body.data.id);
    assert.equal(await store().countDocuments({ _id: new ObjectId(first.body.data.id as string) }), 1);
    assert.equal(failure(await call(sa(), 'POST', base(), { name: 'Altro' }, { 'idempotency-key': key })).status, 409);
    const minimal = await call(sa(), 'POST', base(), { name: 'Minimo' });
    assert.deepEqual([minimal.body.data.text, minimal.body.data.html], ['', '']);
    assert.deepEqual(failure(await world.as.call(sa(), 'POST', base(), { name: 'x' }, { 'idempotency-key': 'nope' })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'Idempotency-Key', issue: 'format' }] });
  });

  it('validates the name and the content: allowlist of fields, sizes in bytes, no control characters but tab, CR and LF, HTML kept as sent', async () => {
    const issues = (reply: Awaited<ReturnType<typeof call>>) => failure(reply).details;
    assert.deepEqual(issues(await call(sa(), 'POST', base(), {})), [{ field: 'name', issue: 'required' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: '   ' })), [{ field: 'name', issue: 'minLength' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x'.repeat(151) })), [{ field: 'name', issue: 'maxLength' }]);
    assert.equal((await call(sa(), 'POST', base(), { name: 'x'.repeat(150) })).status, 201);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'a\nb' })), [{ field: 'name', issue: 'pattern' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 5 })), [{ field: 'name', issue: 'type' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', html: 5 })), [{ field: 'html', issue: 'type' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', extra: 1 })), [{ field: 'extra', issue: 'unknown' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', html: 'a\u0000b' })), [{ field: 'html', issue: 'pattern' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', html: 'a\u001Fb' })), [{ field: 'html', issue: 'pattern' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', html: 'a\u007Fb' })), [{ field: 'html', issue: 'pattern' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', text: 'a\u0008b' })), [{ field: 'text', issue: 'pattern' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', html: 'lone\ud800' })), [{ field: 'html', issue: 'format' }]);
    const exact = '\t\r\n<p onclick="x()">é€</p>  <script>alert(1)</script>';
    const kept = await call(sa(), 'POST', base(), { name: 'Come inviato', html: exact });
    assert.equal(kept.body.data.html, exact);
    // Sizes are bytes: 256 KB of ASCII fits, one more byte does not; a multi-byte character counts for its bytes.
    assert.equal((await call(sa(), 'POST', base(), { name: 'limite', html: 'a'.repeat(MAX_TEMPLATE_HTML_BYTES) })).status, 201);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', html: 'a'.repeat(MAX_TEMPLATE_HTML_BYTES + 1) })), [{ field: 'html', issue: 'maxLength' }]);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', html: '€'.repeat(Math.floor(MAX_TEMPLATE_HTML_BYTES / 3) + 1) })), [{ field: 'html', issue: 'maxLength' }]);
    assert.equal((await call(sa(), 'POST', base(), { name: 'limite', text: 'a'.repeat(MAX_TEMPLATE_TEXT_BYTES) })).status, 201);
    assert.deepEqual(issues(await call(sa(), 'POST', base(), { name: 'x', text: 'a'.repeat(MAX_TEMPLATE_TEXT_BYTES + 1) })), [{ field: 'text', issue: 'maxLength' }]);
  });

  it('refuses a body over the limit with 413 and a body that is not JSON with 415', async () => {
    const big = await call(sa(), 'POST', base(), { name: 'x', html: 'a'.repeat(2 * 1024 * 1024) });
    assert.equal(failure(big).status, 413);
    const text = await fetch(`${world.office.app.baseUrl}/v1${base()}`, { method: 'POST', headers: { ...world.office.userHeaders('POST', base(), await world.as.tokenOf(sa())), 'content-type': 'text/plain', 'idempotency-key': randomUUID() }, body: 'x' });
    assert.equal(text.status, 415);
  });
});

describe('e-mail templates: modification', () => {
  it('changes the given fields with If-Match, returns the new ETag, and records no content', async () => {
    const created = await create({ name: 'Da cambiare', text: 'vecchio', html });
    const id = created.body.data.id as string;
    const mark = world.office.activity.entries.length;
    const changed = await call(sa(), 'PATCH', one(id), { html: '<p>nuovo</p>', name: 'Cambiato' }, { 'if-match': tag(created) });
    assert.equal(changed.status, 200);
    assert.deepEqual([changed.body.data.name, changed.body.data.text, changed.body.data.html], ['Cambiato', 'vecchio', '<p>nuovo</p>']);
    assert.notEqual(tag(changed), tag(created));
    const read = await call(sa(), 'GET', one(id));
    assert.equal(tag(read), tag(changed));
    assert.deepEqual(read.body.data, changed.body.data);
    const stored = await store().findOne({ _id: new ObjectId(id) });
    assert.deepEqual(Object.keys(stored!).sort(), ['_id', 'html', 'insertDate', 'name', 'text', 'updateDate']);
    const entries = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'emailTemplate.updated');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!.resource, { type: 'emailTemplate', id });
    const logged = JSON.stringify(entries);
    assert.ok(!logged.includes(SECRET) && !logged.includes('nuovo') && !logged.includes('vecchio'));
    assert.deepEqual((entries[0]!.changes ?? []).map((change) => change.field).sort(), ['htmlDigest', 'name']);
    // Two changes within the same millisecond still have different versions.
    const again = await call(sa(), 'PATCH', one(id), { text: 'altro' }, { 'if-match': tag(changed) });
    const third = await call(sa(), 'PATCH', one(id), { text: 'ancora' }, { 'if-match': tag(again) });
    assert.notEqual(tag(third), tag(again));
  });

  it('writes nothing for a request that changes nothing, and refuses an empty body, a missing or malformed If-Match and a stale one', async () => {
    const created = await create({ name: 'Fermo', text: 't', html: '<p>h</p>' });
    const id = created.body.data.id as string;
    const mark = world.office.activity.entries.length;
    const same = await call(sa(), 'PATCH', one(id), { name: 'Fermo', text: 't' }, { 'if-match': tag(created) });
    assert.equal(same.status, 200);
    assert.equal(tag(same), tag(created));
    assert.equal(world.office.activity.entries.length, mark);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), {}, { 'if-match': tag(created) })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: '(body)', issue: 'required' }] });
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: 'x' })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'If-Match', issue: 'required' }] });
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: 'x' }, { 'if-match': 'abc' })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'If-Match', issue: 'format' }] });
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { name: 'x' }, { 'if-match': `"${'a'.repeat(43)}"` })).status, 412);
    assert.deepEqual(failure(await call(sa(), 'PATCH', one(id), { name: '' }, { 'if-match': tag(created) })).details, [{ field: 'name', issue: 'minLength' }]);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { html: 'a'.repeat(MAX_TEMPLATE_HTML_BYTES + 1) }, { 'if-match': tag(created) })).status, 422);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { html: 'a'.repeat(2 * 1024 * 1024) }, { 'if-match': tag(created) })).status, 413);
    assert.equal(failure(await call(sa(), 'PATCH', one(hex(new ObjectId())), { name: 'x' }, { 'if-match': tag(created) })).status, 404);
    // A change made by the legacy meanwhile makes the version stale.
    await store().updateOne({ _id: new ObjectId(id) }, { $set: { html: '<p>legacy</p>' } });
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { name: 'x' }, { 'if-match': tag(created) })).status, 412);
  });

  it('works on a template with no dates', async () => {
    const undated = new ObjectId();
    await store().insertOne({ _id: undated, name: 'Senza date', text: '', html: '' });
    const current = await call(sa(), 'GET', one(hex(undated)));
    const changed = await call(sa(), 'PATCH', one(hex(undated)), { name: 'Con date' }, { 'if-match': tag(current) });
    assert.equal(changed.status, 200);
    assert.ok((await store().findOne({ _id: undated }))!['updateDate'] instanceof Date);
  });
});

describe('e-mail templates: repository', () => {
  it('writes only when the template still has the date it was read with', async () => {
    const created = await create({ name: 'Guardia' });
    const id = new ObjectId(created.body.data.id as string);
    const principal = principalOf('SA', { userId: sa(), groupId: world.group(0).groupId });
    const access = (await accessFor(principal, world.group(0).groupId))!;
    const repository = createEmailTemplatesRepository(ctx.databases);
    const read = (await store().findOne({ _id: id }))!['updateDate'];
    assert.equal(await repository.update(principal, access, id, { name: 'Stale', updateDate: new Date() }, new Date(0)), 'conflict');
    assert.equal(await repository.update(principal, access, id, { name: 'Fresh', updateDate: new Date() }, read), 'updated');
    assert.equal(await repository.update(principal, access, new ObjectId(), { name: 'Nobody', updateDate: new Date() }, undefined), 'conflict');
    // A date that is not a date (the legacy writes what it is sent) never reaches the filter, where an object could be read as an operator.
    for (const odd of [{ $gt: 0 }, 'x', 5]) {
      assert.equal(await repository.update(principal, access, id, { name: 'Odd', updateDate: new Date() }, odd), 'conflict');
    }
    assert.equal((await store().findOne({ _id: id }))!['name'], 'Fresh');
  });
});

describe('e-mail templates: the read of the places that use one', () => {
  it('returns only the id, the name and the company, refuses what is not an id, a limit or a verified access', async () => {
    const principal = principalOf('SA', { userId: sa(), groupId: world.group(0).groupId });
    const access = (await accessFor(principal, world.group(0).groupId))!;
    const id = new ObjectId();
    const place = await world.seedPlace(0, 400, 1);
    await ctx.databases.common().collection('places').updateOne({ _id: place }, { $set: { 'appointment.email.templateId': id } });
    const found = await findPlacesUsingTemplate(principal, access, ctx.databases, id, 5);
    assert.deepEqual(found.map((item) => Object.keys(item).sort()), [['_id', 'companyId', 'name']]);
    await assert.rejects(findPlacesUsingTemplate(principal, access, ctx.databases, hex(id) as never, 5), /template id/);
    await assert.rejects(findPlacesUsingTemplate(principal, access, ctx.databases, id, 0), /positive limit/);
    const other = principalOf('SA', { userId: sa(), groupId: world.group(1).groupId });
    await assert.rejects(findPlacesUsingTemplate(other, access, ctx.databases, id, 5));
  });
});

describe('e-mail templates: deletion', () => {
  const seedUse = async (n: number, path: string, value: unknown, extra: Document = {}) => {
    const placeId = await world.seedPlace(0, n, 1, extra);
    await ctx.databases.common().collection('places').updateOne({ _id: placeId }, { $set: { [path]: value } });
    return placeId;
  };

  it('deletes an unused template with 204 and records the deletion without content', async () => {
    const created = await create({ name: 'Libero', text: SECRET, html });
    const mark = world.office.activity.entries.length;
    assert.equal((await call(sa(), 'DELETE', one(created.body.data.id))).status, 204);
    assert.equal(await store().countDocuments({ _id: new ObjectId(created.body.data.id as string) }), 0);
    assert.equal(failure(await call(sa(), 'GET', one(created.body.data.id))).status, 404);
    assert.equal(failure(await call(sa(), 'DELETE', one(created.body.data.id))).status, 404);
    const entries = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'emailTemplate.deleted');
    assert.equal(entries.length, 1);
    assert.ok(!JSON.stringify(entries).includes(SECRET));
  });

  it('refuses with 409 listing the places that use it, from the copies, trashed ones included, in every setting that names a template', async () => {
    const created = await create({ name: 'Usato' });
    const id = created.body.data.id as string;
    const oid = new ObjectId(id);
    const used = [
      await seedUse(201, 'appointment.email.templateId', oid),
      await seedUse(202, 'roomsSettings.reservation.emailNotification.templateId', oid),
      await seedUse(203, 'roomsSettings.reservation.email.templateId', oid, { trash: true }),
      await seedUse(204, 'roomsSettings.reservation.emailConfirmedStatus.templateId', id),
      await seedUse(205, 'roomsSettings.reservation.emailRefusedStatus.templateId', oid),
      await seedUse(206, 'roomsSettings.reservation.emailChangeStatus.templateId', oid),
    ];
    await seedUse(207, 'appointment.email.templateId', new ObjectId());
    const reply = await call(sa(), 'DELETE', one(id));
    assert.equal(failure(reply).status, 409);
    assert.equal(failure(reply).code, 'CONFLICT');
    assert.deepEqual(
      (failure(reply).details as Array<{ field: string; issue: string }>).map((detail) => detail.field).sort(),
      used.map((place) => `places.${hex(place)}`).sort(),
    );
    assert.ok((failure(reply).details as Array<{ issue: string }>).every((detail) => detail.issue === 'referenced'));
    assert.equal(await store().countDocuments({ _id: oid }), 1);
    // A place of another group that names the same id does not count.
    await world.seedPlace(1, 208, 1);
    // Once the places stop using it, it can go.
    await ctx.databases.common().collection('places').updateMany({ _id: { $in: used } }, { $set: { 'appointment.email.templateId': null, 'roomsSettings.reservation': {} } });
    assert.equal((await call(sa(), 'DELETE', one(id))).status, 204);
  });

  it('does not reveal the places outside the perimeter of a company or place administrator, only that there are some', async () => {
    const created = await create({ name: 'Di due aziende' });
    const id = created.body.data.id as string;
    const oid = new ObjectId(id);
    const own = world.group(0).ownPlaceId;
    const other = world.group(0).otherPlaceId;
    const places = ctx.databases.common().collection('places');
    const detailsOf = async (actor: ObjectId) => {
      const reply = await call(actor, 'DELETE', one(id));
      assert.equal(reply.status, 409);
      return failure(reply).details;
    };
    // Used only by a place of the second company: the company administrator learns that it is used, not by whom.
    await places.updateOne({ _id: other }, { $set: { 'appointment.email.templateId': oid } });
    assert.deepEqual(await detailsOf(ca()), [{ field: 'places', issue: 'referenced' }]);
    assert.deepEqual(await detailsOf(pa()), [{ field: 'places', issue: 'referenced' }]);
    assert.deepEqual(await detailsOf(sa()), [{ field: `places.${hex(other)}`, issue: 'referenced' }]);
    // Used by his own place too: his own place is named, the other one is not.
    await places.updateOne({ _id: own }, { $set: { 'roomsSettings.reservation.email.templateId': oid } });
    assert.deepEqual(await detailsOf(ca()), [{ field: `places.${hex(own)}`, issue: 'referenced' }, { field: 'places', issue: 'referenced' }]);
    assert.deepEqual(await detailsOf(pa()), [{ field: `places.${hex(own)}`, issue: 'referenced' }, { field: 'places', issue: 'referenced' }]);
    const all = (await detailsOf(psa())) as Array<{ field: string }>;
    assert.deepEqual(all.map((detail) => detail.field).sort(), [`places.${hex(own)}`, `places.${hex(other)}`].sort());
    assert.ok(!JSON.stringify(await detailsOf(ca())).includes(hex(other)));
    await places.updateMany({ _id: { $in: [own, other] } }, { $unset: { appointment: '', roomsSettings: '' } });
    assert.equal((await call(sa(), 'DELETE', one(id))).status, 204);
  });

  it('lists at most twenty places', async () => {
    const created = await create({ name: 'Molto usato' });
    const oid = new ObjectId(created.body.data.id as string);
    for (let n = 300; n < 323; n += 1) {
      await seedUse(n, 'appointment.email.templateId', oid);
    }
    assert.equal((failure(await call(sa(), 'DELETE', one(created.body.data.id))).details as unknown[]).length, 20);
  });
});

describe('e-mail templates: the content stays out of logs and of the list', () => {
  it('never logs the HTML nor the text, whatever the outcome', async () => {
    const mark = world.office.logEvents.length;
    const created = await create({ name: 'Riservato', text: SECRET, html });
    await call(sa(), 'GET', one(created.body.data.id));
    await call(sa(), 'PATCH', one(created.body.data.id), { html: `${html}<!--${SECRET}-->` }, { 'if-match': tag(created) });
    await call(sa(), 'POST', base(), { name: 'x', html: `${SECRET}\u0000` });
    await call(sa(), 'DELETE', one(created.body.data.id));
    assert.ok(!JSON.stringify(world.office.logEvents.slice(mark)).includes(SECRET));
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(SECRET));
    assert.ok(!JSON.stringify((await call(sa(), 'GET', base())).body).includes(SECRET));
  });
});
