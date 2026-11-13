import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { expectedCopy, sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';
import { startCompaniesWorld } from '../helpers/companies.ts';
import type { CompaniesWorld } from '../helpers/companies.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let world: CompaniesWorld;
const call = (...args: Parameters<CompaniesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const sa = () => world.group(0).sa;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const etagOf = (reply: Awaited<ReturnType<typeof call>>): string => reply.headers.get('etag')!;
const sub = (id: ObjectId, rest = ''): string => world.path(0, `/${hex(id)}${rest}`);
const patch = (id: ObjectId, etag: string | undefined, bodyOf: unknown) => call(sa(), 'PATCH', sub(id), bodyOf, etag === undefined ? {} : { 'if-match': etag });

let sequence = 700;
const fresh = async (): Promise<{ id: ObjectId; etag: string }> => {
  const n = sequence++;
  const id = await world.seed(0, n, { code: `LOGO-${String(n)}`, countryCode: 'DE', countryAreaCode: '' });
  return { id, etag: etagOf(await call(sa(), 'GET', sub(id))) };
};

const FILECTIME = 1_731_490_000_123;
/** A stored image of a group, as the upload writes it; `overrides` break it in the way a test needs. */
async function image(index: number, overrides: Document = {}): Promise<ObjectId> {
  const _id = new ObjectId();
  await ctx.databases
    .group(world.group(index).groupId, 'cluster0')
    .collection('files')
    .insertOne({
      _id,
      groupId: world.group(index).groupId,
      basename: 'logo-bar-1a2b3c4d.png',
      name: 'Logo Bar',
      extension: 'png',
      dirname: '/media/image',
      type: 'image',
      mimetype: 'image/png',
      filectime: new Double(FILECTIME),
      alt: 'Logo Bar alt',
      title: 'Logo Bar title',
      trash: false,
      insertDate: new Date('2024-11-13T10:00:00.000Z'),
      updateDate: new Date('2024-11-13T10:00:00.000Z'),
      ...overrides,
    });
  return _id;
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startCompaniesWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('a company logo set from an image of the group', () => {
  it('stores the descriptor exactly as the legacy Media Manager does: eleven keys in order, the id as a string, filectime a double, mmThumb an empty object; the copy is identical', async () => {
    const { id, etag } = await fresh();
    const imageId = await image(0);
    const reply = await patch(id, etag, { media: { customersAppLogoLight: { imageId: hex(imageId) } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const stored = (((await world.stored(0, id))!['medias'] as Document)['images'] as Document)['customersAppLogoLight'] as Document;
    assert.deepEqual(Object.keys(stored), ['_id', 'dirname', 'basename', 'extension', 'filename', 'mimetype', 'filectime', 'mmThumb', 'type', 'title', 'alt']);
    assert.deepEqual(
      { ...stored, filectime: (stored['filectime'] as Double).value },
      {
        _id: hex(imageId),
        dirname: '/media/image',
        basename: 'logo-bar-1a2b3c4d.png',
        extension: 'png',
        filename: 'Logo Bar',
        mimetype: 'image/png',
        filectime: FILECTIME,
        mmThumb: {},
        type: 'image',
        title: 'Logo Bar title',
        alt: 'Logo Bar alt',
      },
    );
    assert.ok(stored['filectime'] instanceof Double, 'the exact read gives the BSON double');
    assert.equal(typeof stored['_id'], 'string');
    // Written as a double and read by the legacy as a number: ask the database for the types.
    const raw = ctx.databases.group(world.group(0).groupId, 'cluster0').collection('companies');
    assert.equal(await raw.countDocuments({ _id: id, 'medias.images.customersAppLogoLight.filectime': { $type: 'double' }, 'medias.images.customersAppLogoLight._id': { $type: 'string' }, 'medias.images.customersAppLogoLight.mmThumb': { $type: 'object' } }), 1);
    // The copy is identical, and the response shows the ten keys of the representation.
    assert.ok(sameDocument(expectedCopy((await world.stored(0, id))!, world.group(0).groupId), (await world.copyOf(id))!));
    assert.deepEqual(reply.body.data.media.customersAppLogoLight, {
      _id: hex(imageId),
      basename: 'logo-bar-1a2b3c4d.png',
      extension: 'png',
      filename: 'Logo Bar',
      mimetype: 'image/png',
      title: 'Logo Bar title',
      alt: 'Logo Bar alt',
      dirname: '/media/image',
      type: 'image',
      filectime: FILECTIME,
    });
    assert.equal(reply.body.data.media.customersAppLogoDark, null);
  });

  it('is a no-op to pick the same image again or to send the stored descriptor back; picking another one, or null, changes it', async () => {
    const { id, etag } = await fresh();
    const first = await image(0);
    const second = await image(0, { basename: 'second-9f8e7d6c.webp', extension: 'webp', mimetype: 'image/webp', name: 'Second' });
    const set = await patch(id, etag, { media: { customersAppLogoDark: { imageId: hex(first) } } });
    assert.equal(set.status, 200);
    assert.equal(etagOf(await patch(id, etagOf(set), { media: { customersAppLogoDark: { imageId: hex(first) } } })), etagOf(set));
    assert.equal(etagOf(await patch(id, etagOf(set), { media: { customersAppLogoDark: set.body.data.media.customersAppLogoDark } })), etagOf(set));
    const changed = await patch(id, etagOf(set), { media: { customersAppLogoDark: { imageId: hex(second) } } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.media.customersAppLogoDark.basename, 'second-9f8e7d6c.webp');
    const removed = await patch(id, etagOf(changed), { media: { customersAppLogoDark: null } });
    assert.equal(removed.body.data.media.customersAppLogoDark, null);
    assert.equal((((await world.stored(0, id))!['medias'] as Document)['images'] as Document)['customersAppLogoDark'], null);
  });

  it('works on the media block (PUT), on the whole company (PATCH with other fields) and on a creation', async () => {
    const { id, etag } = await fresh();
    const imageId = await image(0);
    const body = (await call(sa(), 'GET', sub(id))).body.data.media;
    const put = await call(sa(), 'PUT', sub(id, '/media'), { ...body, customersAppLogoLight: { imageId: hex(imageId) }, customersAppLogoDark: { imageId: hex(imageId) } }, { 'if-match': etag });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual([put.body.data.media.customersAppLogoLight._id, put.body.data.media.customersAppLogoDark._id], [hex(imageId), hex(imageId)]);
    const created = await call(sa(), 'POST', world.path(0), {
      name: 'Logo Co',
      vatNumber: 'LOGO-CREATED-1',
      address: { street: 'Strasse 1', postcode: '10115', city: 'Berlin', country: 'DE' },
      media: { customersAppLogoLight: { imageId: hex(imageId) } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.media.customersAppLogoLight._id, hex(imageId));
    assert.ok(sameDocument(expectedCopy((await world.stored(0, ObjectId.createFromHexString(created.body.data.id)))!, world.group(0).groupId), (await world.copyOf(ObjectId.createFromHexString(created.body.data.id)))!));
  });

  it('refuses an image that is missing, in the trash, not an image, of another group, or lacking what a logo needs: 422 incorrect, nothing written', async () => {
    const { id, etag } = await fresh();
    const before = (await world.stored(0, id))!;
    const bad: Array<[string, ObjectId]> = [
      ['missing', new ObjectId()],
      ['trashed', await image(0, { trash: true })],
      ['not an image', await image(0, { type: 'video' })],
      ['without a type', await image(0, { type: undefined })],
      ['of another group', await image(1)],
      ['without a file name', await image(0, { basename: undefined })],
      ['with an empty file name', await image(0, { basename: '' })],
      ['without an extension', await image(0, { extension: undefined })],
      ['without a media type', await image(0, { mimetype: 5 })],
      ['without a creation time', await image(0, { filectime: 'yesterday' })],
    ];
    for (const [label, imageId] of bad) {
      assert.deepEqual(failure(await patch(id, etag, { media: { customersAppLogoLight: { imageId: hex(imageId) } } })), issues(['media.customersAppLogoLight', 'incorrect']), label);
    }
    // Two logos, each its own field.
    assert.deepEqual(
      failure(await patch(id, etag, { media: { customersAppLogoLight: { imageId: hex(new ObjectId()) }, customersAppLogoDark: { imageId: hex(await image(1)) } } })),
      issues(['media.customersAppLogoLight', 'incorrect'], ['media.customersAppLogoDark', 'incorrect']),
    );
    assert.deepEqual(await world.stored(0, id), before);
  });

  it('never takes the directory from the document and refuses a document the legacy let a client rewrite into something unsafe', async () => {
    const { id, etag } = await fresh();
    const path = 'media.customersAppLogoLight';
    const rewritten = await patch(id, etag, { media: { customersAppLogoLight: { imageId: hex(await image(0, { dirname: '/../0200000000000000000000ff/media/image' })) } } });
    assert.equal(rewritten.status, 200);
    assert.equal((((await world.stored(0, id))!['medias'] as Document)['images'] as Document)['customersAppLogoLight'] !== null && ((((await world.stored(0, id))!['medias'] as Document)['images'] as Document)['customersAppLogoLight'] as Document)['dirname'], '/media/image');
    for (const overrides of [{ basename: '../x.png' }, { basename: 'a/b.png' }, { basename: 'a?b.png' }, { basename: 'a#b.png' }, { mimetype: 'text/html' }, { extension: 'p/ng' }]) {
      assert.deepEqual(failure(await patch(id, rewritten.headers.get('etag')!, { media: { customersAppLogoDark: { imageId: hex(await image(0, overrides)) } } })), issues(['media.customersAppLogoDark', 'incorrect']), JSON.stringify(overrides));
    }
    void path;
  });

  it('refuses a request that is not exactly { imageId } or null or the stored descriptor', async () => {
    const { id, etag } = await fresh();
    const imageId = hex(await image(0));
    const path = 'media.customersAppLogoLight';
    assert.deepEqual(failure(await patch(id, etag, { media: { customersAppLogoLight: { imageId, basename: '../x.png' } } })), issues([`${path}.basename`, 'unknown']));
    assert.deepEqual(failure(await patch(id, etag, { media: { customersAppLogoLight: { imageId: 'xyz' } } })), issues([`${path}.imageId`, 'minLength']));
    assert.deepEqual(failure(await patch(id, etag, { media: { customersAppLogoLight: { imageId: imageId.toUpperCase() } } })), issues([`${path}.imageId`, 'pattern']));
    assert.deepEqual(failure(await patch(id, etag, { media: { customersAppLogoLight: { imageId: 5 } } })), issues([`${path}.imageId`, 'type']));
    assert.deepEqual(failure(await patch(id, etag, { media: { customersAppLogoLight: { imageId: { $ne: null } } } })), issues([`${path}.imageId`, 'type']));
    assert.deepEqual(failure(await patch(id, etag, { media: { customersAppLogoLight: imageId } })), issues([path, 'type']));
    assert.deepEqual(failure(await patch(id, etag, { media: { customersAppLogoLight: { _id: imageId, basename: 'x.png', extension: 'png', filename: 'x', mimetype: 'image/png', title: 'x', alt: 'x', dirname: '/media/image', type: 'image', filectime: 1 } } })), issues([path, 'notAllowed']));
  });

  it('keeps the rules of every write of a company: If-Match, the perimeter and the role', async () => {
    const { id, etag } = await fresh();
    const imageId = await image(0);
    const logo = { media: { customersAppLogoLight: { imageId: hex(imageId) } } };
    assert.deepEqual(failure(await patch(id, undefined, logo)), issues(['If-Match', 'required']));
    assert.equal(failure(await patch(id, `"${'A'.repeat(43)}"`, logo)).status, 412);
    // A company administrator of another company of the group reaches neither the company nor, through it, the image.
    assert.equal(failure(await call(world.group(0).ca, 'PATCH', sub(id), logo, { 'if-match': etag })).status, 404);
    // His own company works with an image of that company, never with the group's other images.
    const own = fixtureId('company', 1);
    const ownEtag = etagOf(await call(world.group(0).ca, 'GET', sub(own)));
    const incorrect = issues(['media.customersAppLogoLight', 'incorrect']);
    assert.deepEqual(failure(await call(world.group(0).ca, 'PATCH', sub(own), logo, { 'if-match': ownEtag })), incorrect, 'an image of the whole group (or a legacy one) is not his');
    const ofOther = { media: { customersAppLogoLight: { imageId: hex(await image(0, { companyId: fixtureId('company', 2) })) } } };
    assert.deepEqual(failure(await call(world.group(0).ca, 'PATCH', sub(own), ofOther, { 'if-match': ownEtag })), incorrect, 'an image of another company');
    const ofOwn = { media: { customersAppLogoLight: { imageId: hex(await image(0, { companyId: own })) } } };
    assert.equal((await call(world.group(0).ca, 'PATCH', sub(own), ofOwn, { 'if-match': ownEtag })).status, 200);
    assert.equal(failure(await call(world.group(0).pa, 'PATCH', sub(own), logo, { 'if-match': ownEtag })).status, 403);
    // The others may use any image of the group, whoever it belongs to.
    assert.equal((await patch(id, etag, { media: { customersAppLogoLight: { imageId: hex(await image(0, { companyId: own })) } } })).status, 200);
    // Another group's SA cannot use this group's image: the group is the one of the URL, and the image is looked up in its database only.
    const foreign = await world.seed(2, 800, { code: 'FOREIGN-LOGO', countryCode: 'DE', countryAreaCode: '' });
    const foreignPath = world.path(2, `/${hex(foreign)}`);
    const foreignEtag = etagOf(await call(world.group(2).sa, 'GET', foreignPath));
    assert.deepEqual(failure(await call(world.group(2).sa, 'PATCH', foreignPath, logo, { 'if-match': foreignEtag })), issues(['media.customersAppLogoLight', 'incorrect']));
  });
});
