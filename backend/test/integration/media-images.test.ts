import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { OBJECT_CACHE_CONTROL } from '../../src/integrations/gcs/gcs-storage.ts';
import { IMAGE_SIZES, IMAGE_SIZE_NAMES } from '../../src/modules/media/image.types.ts';
import { MAX_IMAGE_BYTES } from '../../src/modules/media/upload.ts';
import { FILES_OWNED_FIELDS } from '../../src/db/collections.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { parseRelated } from '../helpers/fake-gcs.ts';
import { GIF, PNG_POLYGLOT, SVG, animatedWebp, describeImage, hugePng, image, rotatedJpeg } from '../helpers/images.ts';
import { filePart, startMediaWorld } from '../helpers/media.ts';
import type { MediaWorld } from '../helpers/media.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let world: MediaWorld;
const group = (index: number) => world.office.cluster.groups[index]!;
const hex = (id: ObjectId) => id.toHexString();
const sa = () => group(0).sa;
const failure = (reply: Awaited<ReturnType<MediaWorld['upload']>>) => world.as.failure(reply);
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const plain = (status: number, code: string) => ({ status, code, details: undefined });
const filesCollection = (index: number) => ctx.databases.group(group(index).groupId, 'cluster0').collection('files');

before(async () => {
  ctx = await openTestDatabases();
  world = await startMediaWorld(ctx, { env: { RATE_LIMIT_MEDIA_UPLOAD_PER_USER: '1000' } });
  // Group 0 has a valid files host, group 1 keeps the fixture's value (no scheme), which cannot be used to build a URL.
  await ctx.databases.common().collection('groups').updateOne({ _id: group(0).groupId }, { $set: { filesHost: 'https://files.example.test/cdn/' } });
});
after(async () => {
  await world.close();
  await ctx.cleanup();
});

describe('POST /v1/groups/{groupId}/media/images', () => {
  it('stores five resized objects at the legacy paths and a files document identical in shape to the legacy one', async () => {
    const before = world.fake.requests.length;
    const source = await image('png', 1500, 750, { alpha: true });
    const reply = await world.upload(sa(), 0, [filePart(source, 'Caffè Società.PNG', 'text/html')]);
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const created = reply.body.data;
    const groupHex = hex(group(0).groupId);

    // The objects: path, content type from the bytes (not from the declared text/html), cache header, ifGenerationMatch, widths.
    const uploads = world.fake.requests.slice(before).filter((request) => request.method === 'POST' && request.path.startsWith('/upload/'));
    assert.equal(uploads.length, 5);
    const basename = created.urls.m.split('/').pop() as string;
    assert.match(decodeURIComponent(basename), /^caffe-societa-[0-9a-f]{8}\.png$/);
    for (const size of IMAGE_SIZE_NAMES) {
      const name = `${groupHex}/media/image/${size}/${decodeURIComponent(basename)}`;
      const stored = world.fake.objects.get(name)!;
      assert.equal(stored.contentType, 'image/png');
      assert.equal(stored.cacheControl, OBJECT_CACHE_CONTROL);
      const described = await describeImage(stored.bytes);
      assert.deepEqual([described.format, described.width, described.hasAlpha], ['png', IMAGE_SIZES[size], true]);
      const request = uploads.find((candidate) => candidate.query.get('name') === name)!;
      assert.equal(request.query.get('ifGenerationMatch'), '0');
      assert.equal(parseRelated(request.body, String(request.headers['content-type'])).mediaType, 'image/png');
    }

    // The representation and the Location.
    assert.equal(reply.headers.get('location'), `/v1${world.path(0, `/${created.id}`)}`);
    assert.deepEqual(Object.keys(created), ['id', 'name', 'title', 'alt', 'companyId', 'extension', 'mimetype', 'createdAt', 'urls']);
    assert.equal(created.companyId, null);
    assert.deepEqual([created.name, created.title, created.alt, created.extension, created.mimetype], ['Caffè Società', 'Caffè Società', 'Caffè Società', 'png', 'image/png']);
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(created.urls, Object.fromEntries(IMAGE_SIZE_NAMES.map((size) => [size, `https://files.example.test/cdn/${groupHex}/media/image/${size}/${basename}`])));

    // The document: keys, order and types of the legacy `files`.
    const document = (await filesCollection(0).findOne({ _id: ObjectId.createFromHexString(created.id) }))!;
    assert.deepEqual(Object.keys(document), ['_id', 'groupId', 'basename', 'name', 'extension', 'dirname', 'type', 'mimetype', 'filectime', 'alt', 'title', 'trash', 'insertDate', 'updateDate', 'createdBy', 'companyId']);
    assert.deepEqual([document['createdBy'], document['companyId']], [sa(), null]);
    assert.deepEqual(Object.keys(document).filter((key) => key !== '_id' && !FILES_OWNED_FIELDS.includes(key)), []);
    assert.deepEqual(
      [document['groupId'], document['basename'], document['name'], document['extension'], document['dirname'], document['type'], document['mimetype'], document['alt'], document['title'], document['trash']],
      [group(0).groupId, decodeURIComponent(basename), 'Caffè Società', 'png', '/media/image', 'image', 'image/png', 'Caffè Società', 'Caffè Società', false],
    );
    assert.ok(document['insertDate'] instanceof Date && document['updateDate'] instanceof Date);
    assert.equal(typeof document['filectime'], 'number');
    assert.equal(await filesCollection(0).countDocuments({ _id: document['_id'], filectime: { $type: 'double' } }), 1, 'filectime is stored as a BSON double');
    assert.equal(document['filectime'], (document['insertDate'] as Date).getTime());
    void Double;
  });

  it('turns a JPEG upright, strips its metadata and keeps the format; accepts a WebP', async () => {
    const jpeg = await world.upload(sa(), 0, [filePart(await rotatedJpeg(), 'rotated.jpeg', 'image/jpeg')]);
    assert.equal(jpeg.status, 201);
    assert.equal(jpeg.body.data.extension, 'jpg');
    assert.equal(jpeg.body.data.mimetype, 'image/jpeg');
    const name = (size: string) => `${hex(group(0).groupId)}/media/image/${size}/${decodeURIComponent(jpeg.body.data.urls.xs.split('/').pop())}`;
    const xl = world.fake.objects.get(name('xl'))!;
    assert.equal(xl.contentType, 'image/jpeg');
    assert.deepEqual(await describeImage(xl.bytes), { width: 40, height: 80, format: 'jpeg', hasExif: false, hasAlpha: false, orientation: undefined });
    assert.equal(xl.bytes.includes(Buffer.from('secret-copyright')), false);

    const webp = await world.upload(sa(), 0, [filePart(await image('webp', 300, 100), 'banner.webp', 'application/octet-stream')]);
    assert.equal(webp.status, 201);
    assert.deepEqual([webp.body.data.extension, webp.body.data.mimetype], ['webp', 'image/webp']);
  });

  it('gives a name that cannot be used as a path: the slug, never the client text', async () => {
    const reply = await world.upload(sa(), 0, [filePart(await image('png'), '../../etc/pass wd.png')]);
    assert.equal(reply.status, 201);
    assert.match(reply.body.data.urls.s, /\/media\/image\/s\/pass-wd-[0-9a-f]{8}\.png$/);
    const stored = [...world.fake.objects.keys()].filter((name) => name.includes('pass-wd'));
    assert.equal(stored.length, 5);
    assert.ok(stored.every((name) => name.startsWith(`${hex(group(0).groupId)}/media/image/`) && !name.includes('..')));
    const unnamed = await world.upload(sa(), 0, [filePart(await image('png'), '日本.png')]);
    assert.match(unnamed.body.data.urls.s, /\/s\/image-[0-9a-f]{8}\.png$/);
    assert.equal(unnamed.body.data.title, '日本');
  });

  it('uploads into the group of the URL, for a platform administrator, a dealer and a company administrator; urls are null when the group has no usable https host', async () => {
    const root = world.office.cluster.psa;
    const viaPsa = await world.upload(root, 1, [filePart(await image('png'))]);
    assert.equal(viaPsa.status, 201);
    assert.equal(viaPsa.body.data.urls, null, 'the files host of group 1 has no scheme');
    assert.equal((await world.files(1)).length, 1);
    assert.equal((await world.files(1))[0]!['groupId'].toHexString(), hex(group(1).groupId));
    assert.ok([...world.fake.objects.keys()].some((name) => name.startsWith(`${hex(group(1).groupId)}/media/image/xl/`)));
    const viaDealer = await world.upload(world.office.cluster.dealerA, 1, [filePart(await image('png'))]);
    assert.equal(viaDealer.status, 201);
    assert.equal((await world.files(1)).length, 2);
    const ownCompany = fixtureId('company', 1);
    const viaCa = await world.upload(group(0).ca, 0, [filePart(await image('png'))], {}, `?companyId=${hex(ownCompany)}`);
    assert.equal(viaCa.status, 201);
    assert.equal(viaCa.body.data.companyId, hex(ownCompany));
    assert.deepEqual((await world.files(0)).filter((file) => file['groupId'].toHexString() !== hex(group(0).groupId)), []);
  });

  it('refuses without credentials, without the permission and across groups, and stores nothing', async () => {
    const mark = world.fake.requests.length;
    const filesBefore = (await world.files(0)).length;
    const bytes = await image('png');
    const anonymous = await fetch(`${world.office.app.baseUrl}/v1${world.path(0)}`, { method: 'POST', body: new FormData() });
    assert.equal(anonymous.status, 401);
    assert.equal(failure(await world.upload(group(0).pa, 0, [filePart(bytes)])).status, 403, 'a place administrator may not');
    assert.deepEqual(failure(await world.upload(group(0).sa, 2, [filePart(bytes)])), plain(404, 'NOT_FOUND'), 'another dealer\'s group does not exist for an SA of group 0');
    assert.deepEqual(failure(await world.upload(world.office.cluster.dealerB, 0, [filePart(bytes)])), plain(404, 'NOT_FOUND'));
    assert.deepEqual(failure(await world.upload(group(2).sa, 0, [filePart(bytes)])), plain(404, 'NOT_FOUND'));
    assert.equal(world.fake.requests.length, mark, 'no call to the storage');
    assert.equal((await world.files(0)).length, filesBefore);
  });

  it('rejects what is not an acceptable body', async () => {
    const bytes = await image('png');
    // 413: more than 10 MB.
    const big = await world.upload(sa(), 0, [filePart(Buffer.concat([bytes, Buffer.alloc(MAX_IMAGE_BYTES)]))]);
    assert.deepEqual(failure(big), plain(413, 'PAYLOAD_TOO_LARGE'));
    // 415: not multipart at all, and a file that is not a JPEG, PNG or WebP by its bytes whatever it is called.
    const json = await world.as.call(sa(), 'POST', world.path(0), { file: 'x' });
    assert.deepEqual(failure(json), plain(415, 'UNSUPPORTED_MEDIA_TYPE'));
    const bare = await fetch(`${world.office.app.baseUrl}/v1${world.path(0)}`, { method: 'POST', headers: { authorization: `Bearer ${await world.as.tokenOf(sa())}` } });
    assert.equal(bare.status, 415);
    for (const [content, name, type] of [
      [GIF, 'animation.gif', 'image/gif'],
      [GIF, 'fake.png', 'image/png'],
      [SVG, 'vector.svg', 'image/svg+xml'],
      [SVG, 'vector.png', 'image/png'],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'page.png', 'image/png'],
      [Buffer.alloc(0), 'empty.png', 'image/png'],
    ] as const) {
      assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(content, name, type)])), plain(415, 'UNSUPPORTED_MEDIA_TYPE'), name);
    }
    // 422: the field, the parts, the content of the image.
    assert.deepEqual(failure(await world.upload(sa(), 0, [{ name: 'image', bytes, filename: 'a.png', type: 'image/png' }])), issues(['file', 'unknown']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(bytes), { name: 'title', bytes: 'Hello' }])), issues(['(body)', 'unknown']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [{ name: 'title', bytes: 'Hello' }])), issues(['(body)', 'unknown']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(bytes), filePart(bytes, 'b.png')])), issues(['(body)', 'unknown']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [])), issues(['file', 'required']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(PNG_POLYGLOT)])), issues(['file', 'incorrect']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(await hugePng())])), issues(['file', 'incorrect']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(await animatedWebp(), 'a.webp', 'image/webp')])), issues(['file', 'incorrect']));
    // 400: a multipart header with a body that is not multipart.
    const malformed = await fetch(`${world.office.app.baseUrl}/v1${world.path(0)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await world.as.tokenOf(sa())}`, 'content-type': 'multipart/form-data; boundary=xyz' },
      body: 'this is not a multipart body',
    });
    assert.equal(malformed.status, 400);
    const noBoundary = await fetch(`${world.office.app.baseUrl}/v1${world.path(0)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await world.as.tokenOf(sa())}`, 'content-type': 'multipart/form-data' },
      body: 'x',
    });
    assert.equal(noBoundary.status, 400);
  });
});

describe('GET /v1/groups/{groupId}/media/images', () => {
  const insert = (index: number, n: number, overrides: Document = {}) =>
    filesCollection(index).insertOne({
      _id: new ObjectId(),
      groupId: group(index).groupId,
      basename: `seed-${String(n)}.png`,
      name: `Seed ${String(n)}`,
      extension: 'png',
      dirname: '/media/image',
      type: 'image',
      mimetype: 'image/png',
      filectime: new Double(1_700_000_000_000 + n),
      alt: `Alt ${String(n)}`,
      title: `Title ${String(n)}`,
      trash: false,
      insertDate: new Date(Date.UTC(2023, 0, n)),
      updateDate: new Date(Date.UTC(2023, 0, n)),
      ...overrides,
    });

  before(async () => {
    await filesCollection(3).deleteMany({});
    for (let n = 1; n <= 5; n += 1) {
      await insert(3, n);
    }
    await insert(3, 6, { trash: true, name: 'Trashed' });
    await insert(3, 7, { type: 'video', name: 'A video' });
    await insert(3, 8, { basename: 'weird .*.png', name: 'Dots.*Here', title: 'Dots.*Here' });
    await filesCollection(3).insertOne({ _id: new ObjectId(), type: 'image' });
    await ctx.databases.common().collection('groups').updateOne({ _id: group(3).groupId }, { $set: { filesHost: 'https://cdn.example.test' } });
  });

  const list = (actor: ObjectId, index: number, query = '') => world.as.call(actor, 'GET', world.path(index, query));

  it('lists the images that are not in the trash, newest first, with the fields of the image and the five URLs', async () => {
    const reply = await list(group(3).sa, 3);
    assert.equal(reply.status, 200);
    const names = reply.body.data.map((item: { name: string }) => item.name);
    assert.deepEqual(names.slice(0, 6), ['Dots.*Here', 'Seed 5', 'Seed 4', 'Seed 3', 'Seed 2', 'Seed 1']);
    assert.equal(names.includes('Trashed'), false);
    assert.equal(names.includes('A video'), false);
    assert.deepEqual(reply.body.page, { limit: 50, next: null });
    const [, newest] = reply.body.data;
    assert.deepEqual(newest, {
      id: newest.id,
      name: 'Seed 5',
      title: 'Title 5',
      alt: 'Alt 5',
      companyId: null,
      extension: 'png',
      mimetype: 'image/png',
      createdAt: '2023-01-05T00:00:00.000Z',
      urls: Object.fromEntries(IMAGE_SIZE_NAMES.map((size) => [size, `https://cdn.example.test/${hex(group(3).groupId)}/media/image/${size}/seed-5.png`])),
    });
    assert.equal(reply.body.data[0].urls.s.endsWith('/weird%20.*.png'), true, 'the file name is encoded in the URL');
  });

  it('reads a legacy document that lacks fields without failing', async () => {
    const reply = await list(group(3).sa, 3, '?sort=createdAt&limit=1');
    assert.deepEqual(reply.body.data[0], { id: reply.body.data[0].id, name: '', title: '', alt: '', companyId: null, extension: '', mimetype: null, createdAt: null, urls: null });
  });

  it('pages with a cursor of at most 50 and sorts by name', async () => {
    const first = await list(group(3).sa, 3, '?limit=2&sort=name');
    assert.deepEqual(first.body.data.map((item: { name: string }) => item.name), ['', 'Dots.*Here']);
    assert.ok(first.body.page.next);
    const second = await list(group(3).sa, 3, `?limit=2&sort=name&cursor=${first.body.page.next as string}`);
    assert.deepEqual(second.body.data.map((item: { name: string }) => item.name), ['Seed 1', 'Seed 2']);
    assert.deepEqual(world.as.failure(await list(group(3).sa, 3, '?limit=51')), issues(['limit', 'maximum']));
    assert.deepEqual(world.as.failure(await list(group(3).sa, 3, '?limit=0')), issues(['limit', 'minimum']));
    assert.deepEqual(world.as.failure(await list(group(3).sa, 3, '?cursor=bad')), issues(['cursor', 'format']));
    assert.deepEqual(world.as.failure(await list(group(3).sa, 3, '?sort=insertDate')), issues(['sort', 'enum']));
    assert.deepEqual(world.as.failure(await list(group(3).sa, 3, '?unknown=1')), issues(['unknown', 'unknown']));
  });

  it('searches the name, the title and the file name as literal text', async () => {
    const byName = await list(group(3).sa, 3, '?q=seed%203');
    assert.deepEqual(byName.body.data.map((item: { name: string }) => item.name), ['Seed 3']);
    const byTitle = await list(group(3).sa, 3, '?q=TITLE%204');
    assert.deepEqual(byTitle.body.data.map((item: { name: string }) => item.name), ['Seed 4']);
    const literal = await list(group(3).sa, 3, '?q=.*');
    assert.deepEqual(literal.body.data.map((item: { name: string }) => item.name), ['Dots.*Here'], '.* is text, not a pattern');
    assert.deepEqual((await list(group(3).sa, 3, '?q=nothing-like-this')).body.data, []);
  });

  it('is limited to the group of the URL and to who has the permission', async () => {
    assert.deepEqual((await list(group(0).sa, 0)).body.data.every((item: { urls: { s: string } | null }) => item.urls === null || item.urls.s.includes(hex(group(0).groupId))), true);
    assert.deepEqual(world.as.failure(await list(group(0).sa, 3)), plain(404, 'NOT_FOUND'));
    assert.deepEqual(world.as.failure(await list(group(3).pa, 3)), plain(403, 'FORBIDDEN'));
    assert.equal((await list(group(3).ca, 3)).status, 200, 'a company administrator lists the images of his companies (none here)');
    assert.equal((await list(world.office.cluster.psa, 3)).status, 200);
  });

  it('reads one image and answers 404 for a trashed, a missing, a non image and another group\'s one', async () => {
    const seed = (await filesCollection(3).findOne({ name: 'Seed 1' }))!;
    const one = await world.as.call(group(3).sa, 'GET', world.path(3, `/${hex(seed['_id'])}`));
    assert.equal(one.status, 200);
    assert.equal(one.body.data.name, 'Seed 1');
    const trashed = (await filesCollection(3).findOne({ name: 'Trashed' }))!;
    const video = (await filesCollection(3).findOne({ name: 'A video' }))!;
    for (const id of [hex(trashed['_id']), hex(video['_id']), hex(new ObjectId())]) {
      assert.deepEqual(world.as.failure(await world.as.call(group(3).sa, 'GET', world.path(3, `/${id}`))), plain(404, 'NOT_FOUND'));
    }
    // The same id read through another group is a different database: not found.
    assert.deepEqual(world.as.failure(await world.as.call(group(2).sa, 'GET', world.path(2, `/${hex(seed['_id'])}`))), plain(404, 'NOT_FOUND'));
    assert.equal(world.as.failure(await world.as.call(group(3).sa, 'GET', world.path(3, '/not-an-id'))).status, 422);
  });
});

describe('who an image belongs to', () => {
  const C1 = fixtureId('company', 1);
  const C2 = fixtureId('company', 2);
  const query = (id: ObjectId) => `?companyId=${hex(id)}`;

  it('makes a company administrator name one of his own companies, and checks the company for everybody', async () => {
    const bytes = await image('png');
    assert.deepEqual(failure(await world.upload(group(0).ca, 0, [filePart(bytes)])), issues(['companyId', 'required']));
    assert.deepEqual(failure(await world.upload(group(0).ca, 0, [filePart(bytes)], {}, query(C2))), plain(404, 'NOT_FOUND'), 'a company of the group that is not his');
    assert.deepEqual(failure(await world.upload(group(0).ca, 1, [filePart(bytes)], {}, query(C1))), plain(404, 'NOT_FOUND'), 'a group that is not his');
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(bytes)], {}, query(new ObjectId()))), issues(['companyId', 'incorrect']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(bytes)], {}, '?companyId=xyz')), issues(['companyId', 'format']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(bytes)], {}, '?other=1')), issues(['other', 'unknown']));
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(bytes)], {}, `?companyId=${hex(fixtureId('company', 1))}&companyId=${hex(C2)}`)), issues(['companyId', 'type']));
    const common = ctx.databases.common().collection('companies');
    await common.updateOne({ _id: C2 }, { $set: { trash: true } });
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(bytes)], {}, query(C2))), issues(['companyId', 'incorrect']), 'a company in the trash');
    await common.updateOne({ _id: C2 }, { $set: { trash: false } });
    const own = await world.upload(sa(), 0, [filePart(bytes)], {}, query(C2));
    assert.equal(own.status, 201);
    assert.equal((await filesCollection(0).findOne({ _id: ObjectId.createFromHexString(own.body.data.id) }))!['companyId'].toHexString(), hex(C2));
  });

  it('shows a company administrator only the images of his companies; the others see all, and everybody can filter by company', async () => {
    await filesCollection(0).deleteMany({});
    const seed = (name: string, extra: Document) => filesCollection(0).insertOne({ _id: new ObjectId(), groupId: group(0).groupId, basename: `${name}.png`, name, type: 'image', extension: 'png', mimetype: 'image/png', trash: false, insertDate: new Date(), ...extra });
    await seed('mine', { companyId: C1 });
    await seed('theirs', { companyId: C2 });
    await seed('legacy', {});
    await seed('whole-group', { companyId: null });
    const names = async (actor: ObjectId, rest = '') => ((await world.as.call(actor, 'GET', world.path(0, rest))).body.data as Array<{ name: string }>).map((item) => item.name).sort();
    assert.deepEqual(await names(group(0).ca), ['mine']);
    assert.deepEqual(await names(sa()), ['legacy', 'mine', 'theirs', 'whole-group']);
    assert.deepEqual(await names(world.office.cluster.psa), ['legacy', 'mine', 'theirs', 'whole-group']);
    assert.deepEqual(await names(sa(), query(C2)), ['theirs']);
    assert.deepEqual(await names(group(0).ca, query(C1)), ['mine']);
    assert.deepEqual(await names(group(0).ca, query(C2)), [], 'a company that is not his gives nothing, not an error');
    assert.deepEqual(await names(group(0).ca, '?q=legacy'), []);
    const ids = new Map((await filesCollection(0).find({}).toArray()).map((file) => [file['name'] as string, hex(file['_id'])]));
    const read = async (actor: ObjectId, name: string) => (await world.as.call(actor, 'GET', world.path(0, `/${ids.get(name)!}`))).status;
    assert.deepEqual([await read(group(0).ca, 'mine'), await read(group(0).ca, 'theirs'), await read(group(0).ca, 'legacy'), await read(group(0).ca, 'whole-group')], [200, 404, 404, 404]);
    assert.deepEqual([await read(sa(), 'theirs'), await read(sa(), 'legacy')], [200, 200]);
    assert.equal((await world.as.call(sa(), 'GET', world.path(0, `/${ids.get('mine')!}`))).body.data.companyId, hex(C1));
  });

  it('refuses a body or a query that is not understood, and a user who still has to replace his provisional password', async () => {
    const bytes = await image('png');
    assert.deepEqual(failure(await world.upload(sa(), 0, [filePart(bytes), { name: 'second', bytes, filename: 'b.png', type: 'image/png' }])), issues(['(body)', 'unknown']), 'a second file in another field');
    assert.deepEqual(world.as.failure(await world.as.call(sa(), 'GET', world.path(0, '?q[$ne]='))), issues(['(key)', 'unknown']));
    assert.deepEqual(world.as.failure(await world.as.call(sa(), 'GET', world.path(0, '?limit=51'))), issues(['limit', 'maximum']));
    const name = 'newcomer-media';
    const created = await world.as.call(sa(), 'POST', `/groups/${hex(group(0).groupId)}/users`, { username: name, password: 'Prov-Pass-Fixture-12345', role: 'PA', placeIds: [hex(fixtureId('place', 1))] }); // gitleaks:allow (fake test value)
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const login = await world.office.login(name, 'Prov-Pass-Fixture-12345');
    const { accessToken } = ((await login.json()) as { data: { accessToken: string } }).data;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'a.png');
    const response = await fetch(`${world.office.app.baseUrl}/v1${world.path(0)}`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: form });
    assert.deepEqual([response.status, ((await response.json()) as { error: { code: string } }).error.code], [403, 'PASSWORD_CHANGE_REQUIRED']);
  });
});

/** Runs a test body over a world of its own, on its own throw-away databases (a world seeds the whole cluster). */
async function withWorld(options: Parameters<typeof startMediaWorld>[1], work: (own: MediaWorld, databases: TestDatabases) => Promise<void>): Promise<void> {
  const databases = await openTestDatabases();
  const own = await startMediaWorld(databases, options);
  try {
    await work(own, databases);
  } finally {
    await own.close();
    await databases.cleanup();
  }
}

describe('uploads and lists are not possible without a storage, and are limited per user', () => {
  it('answers 503 to the upload before reading the body when the storage is disabled, and still lists', async () => {
    await withWorld({ storage: false }, async (off) => {
      const actor = off.office.cluster.groups[0]!.sa;
      const reply = await off.upload(actor, 0, [filePart(await image('png'))]);
      assert.deepEqual(off.as.failure(reply), plain(503, 'SERVICE_UNAVAILABLE'));
      assert.equal(off.fake.requests.length, 0);
      assert.equal((await off.as.call(actor, 'GET', off.path(0))).status, 200);
      // Not even a request that is not multipart gets further than the 503.
      assert.equal(off.as.failure(await off.as.call(actor, 'POST', off.path(0), {})).status, 503);
    });
  });

  it('answers 429 with Retry-After when a user uploads more than the limit in a minute', async () => {
    await withWorld({ env: { RATE_LIMIT_MEDIA_UPLOAD_PER_USER: '2' } }, async (limited) => {
      const actor = limited.office.cluster.groups[0]!.sa;
      const bytes = await image('png');
      assert.equal((await limited.upload(actor, 0, [filePart(bytes)])).status, 201);
      assert.equal((await limited.upload(actor, 0, [filePart(bytes)])).status, 201);
      const third = await limited.upload(actor, 0, [filePart(bytes)]);
      assert.deepEqual(limited.as.failure(third), plain(429, 'RATE_LIMITED'));
      assert.ok(Number(third.headers.get('retry-after')) >= 1);
      assert.equal(limited.fake.objects.size, 10, 'the refused upload stored nothing');
      // Another user has his own counter, and reading is not limited by the upload rule.
      assert.equal((await limited.upload(limited.office.cluster.groups[0]!.ca, 0, [filePart(bytes)], {}, `?companyId=${hex(fixtureId('company', 1))}`)).status, 201);
      assert.equal((await limited.as.call(actor, 'GET', limited.path(0))).status, 200);
    });
  });
});

describe('daily quotas', () => {
  it('answers 429 when a user passes his daily quota, whatever the minute limit says', async () => {
    await withWorld({ env: { RATE_LIMIT_MEDIA_UPLOAD_PER_USER_DAILY: '2' } }, async (limited) => {
      const actor = limited.office.cluster.groups[0]!.sa;
      const bytes = await image('png');
      assert.equal((await limited.upload(actor, 0, [filePart(bytes)])).status, 201);
      assert.equal((await limited.upload(actor, 0, [filePart(bytes)])).status, 201);
      const third = await limited.upload(actor, 0, [filePart(bytes)]);
      assert.deepEqual(limited.as.failure(third), plain(429, 'RATE_LIMITED'));
      assert.ok(limited.fake.objects.size === 10);
      assert.equal((await limited.upload(limited.office.cluster.psa, 0, [filePart(bytes)])).status, 201, 'another user has his own quota');
    });
  });

  it('answers 429 when a group passes its daily quota, counting only the requests that reached the group: a user without the permission, or in another group, never consumes it', async () => {
    await withWorld({ env: { RATE_LIMIT_MEDIA_UPLOAD_PER_GROUP_DAILY: '2' } }, async (limited) => {
      const groups = limited.office.cluster.groups;
      const bytes = await image('png');
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await limited.upload(groups[0]!.pa, 0, [filePart(bytes)])).status, 403);
        assert.equal((await limited.upload(groups[1]!.sa, 0, [filePart(bytes)])).status, 404);
      }
      assert.equal((await limited.upload(groups[0]!.sa, 0, [filePart(bytes)])).status, 201);
      assert.equal((await limited.upload(limited.office.cluster.psa, 0, [filePart(bytes)])).status, 201);
      const third = await limited.upload(groups[0]!.ca, 0, [filePart(bytes)], {}, `?companyId=${hex(fixtureId('company', 1))}`);
      assert.deepEqual(limited.as.failure(third), plain(429, 'RATE_LIMITED'));
      assert.equal((await limited.upload(groups[1]!.sa, 1, [filePart(bytes)])).status, 201, 'another group has its own quota');
    });
  });
});

describe('a failure of the storage or of the database', () => {
  it('removes the objects already uploaded and answers 503 when an upload fails, logging the cause without a URL or a token', async () => {
    await withWorld({}, async (broken) => {
      let posts = 0;
      broken.fake.intercept = (request) => (request.method === 'POST' && request.path.startsWith('/upload/') && ++posts === 3 ? { status: 403 } : undefined);
      const reply = await broken.upload(broken.office.cluster.groups[0]!.sa, 0, [filePart(await image('png'))]);
      assert.deepEqual(broken.as.failure(reply), plain(503, 'SERVICE_UNAVAILABLE'));
      assert.equal(broken.fake.objects.size, 0, 'the objects that were stored are gone');
      assert.equal((await broken.files(0)).length, 0, 'no document');
      assert.equal(broken.fake.requests.filter((request) => request.method === 'DELETE').length, 4, 'only the four objects this request stored are removed, each by its generation');
      assert.ok(broken.fake.requests.filter((request) => request.method === 'DELETE').every((request) => request.query.get('ifGenerationMatch') !== null));
      assert.equal(broken.fake.requests.filter((request) => request.method === 'GET' && request.path.startsWith('/storage/')).length, 1, 'the one that failed is checked by its bytes, found missing, left alone');
      const logged = broken.office.logEvents.find((event) => event['msg'] === 'image upload to the storage failed')!;
      assert.deepEqual([logged['operation'], logged['reason'], logged['status']], ['upload', 'status', 403]);
      assert.equal(JSON.stringify(logged).includes('token-'), false);
      assert.equal(/127\.0\.0\.1|http|bucket/.test(JSON.stringify(logged)), false, 'no URL, no bucket');
    });
  });

  it('logs an object that cannot be removed and still answers 503; a storage that is unreachable is a 503 too', async () => {
    await withWorld({}, async (broken) => {
      const actor = broken.office.cluster.groups[0]!.sa;
      let posts = 0;
      broken.fake.intercept = (request) => (request.method === 'DELETE' ? { status: 403 } : request.path.startsWith('/upload/') && ++posts === 2 ? { status: 400 } : undefined);
      assert.equal((await broken.upload(actor, 0, [filePart(await image('png'))])).status, 503);
      assert.equal(broken.office.logEvents.filter((event) => event['msg'] === 'an uploaded object could not be removed after a failed upload').length, 4);
      broken.fake.intercept = () => ({ drop: true });
      assert.equal((await broken.upload(actor, 0, [filePart(await image('png'))])).status, 503);
    });
  });

  it('removes the five objects and answers 500 when the document cannot be inserted', async () => {
    await withWorld({}, async (broken, databases) => {
      const target = broken.office.cluster.groups[1]!;
      await databases.databases.group(target.groupId, 'cluster0').createCollection('files', { validator: { $jsonSchema: { bsonType: 'object', required: ['neverThere'] } }, validationAction: 'error' });
      const reply = await broken.upload(target.sa, 1, [filePart(await image('png'))]);
      assert.deepEqual(broken.as.failure(reply), plain(500, 'INTERNAL_ERROR'));
      assert.equal(broken.fake.objects.size, 0);
      assert.equal(broken.fake.requests.filter((request) => request.method === 'DELETE').length, 5);
    });
  });
});

void IMAGE_SIZES;
