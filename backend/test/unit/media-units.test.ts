import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { StorageError } from '../../src/integrations/gcs/index.ts';
import type { MediaStorage } from '../../src/integrations/gcs/index.ts';
import { IMAGE_SIZE_NAMES } from '../../src/modules/media/image.types.ts';
import { filesHostOf, imageUrls, newFileDocument, toImage, toLogoSource } from '../../src/modules/media/media.mapper.ts';
import type { MediaRepository } from '../../src/modules/media/media.repository.ts';
import { createMediaService } from '../../src/modules/media/media.service.ts';
import type { MediaService } from '../../src/modules/media/media.service.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { memoryLogger } from '../helpers/app.ts';
import { image } from '../helpers/images.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { principalOf } from '../helpers/principal.ts';

const GROUP = fixtureId('group', 1);
const HEX = GROUP.toHexString();
const access = { groupId: GROUP, clusterId: 'cluster0', crossGroup: false, features: {} } as unknown as GroupAccess;

describe('files host', () => {
  it('accepts an https URL without credentials, query or fragment, without the trailing slash', () => {
    assert.equal(filesHostOf('https://files.example.test'), 'https://files.example.test');
    assert.equal(filesHostOf('https://files.example.test/'), 'https://files.example.test');
    assert.equal(filesHostOf('https://files.example.test/cdn//'), 'https://files.example.test/cdn');
    assert.equal(filesHostOf('https://files.example.test:8443/a/b'), 'https://files.example.test:8443/a/b');
  });

  it('gives null for anything else: not text, not a URL, not https, credentials, query, fragment', () => {
    for (const value of [undefined, null, 5, {}, '', 'files.example.test', 'http://files.example.test', 'ftp://x.test', 'https://user:pw@files.example.test', 'https://:pw@files.example.test', 'https://files.example.test/?a=1', 'https://files.example.test/#x', 'javascript:alert(1)']) {
      assert.equal(filesHostOf(value), null, String(value));
    }
  });
});

describe('image URLs and representation', () => {
  it('builds the five URLs with the basename encoded, or none without a host or a name', () => {
    const urls = imageUrls('https://cdn.test', HEX, 'a b#c.png')!;
    assert.deepEqual(Object.keys(urls), [...IMAGE_SIZE_NAMES]);
    assert.equal(urls.xl, `https://cdn.test/${HEX}/media/image/xl/a%20b%23c.png`);
    assert.equal(imageUrls(null, HEX, 'a.png'), null);
    assert.equal(imageUrls('https://cdn.test', HEX, ''), null);
    assert.equal(imageUrls('https://cdn.test', HEX, 5), null);
  });

  it('reads a complete document and a poor one without failing', () => {
    const id = new ObjectId();
    const full: Document = { _id: id, basename: 'a.png', name: 'N', title: 'T', alt: 'A', companyId: new ObjectId('0123456789abcdef01234567'), extension: 'png', mimetype: 'image/png', insertDate: new Date('2024-01-02T03:04:05.000Z') };
    assert.deepEqual(toImage(full, 'https://cdn.test', HEX), { id: id.toHexString(), name: 'N', title: 'T', alt: 'A', companyId: '0123456789abcdef01234567', extension: 'png', mimetype: 'image/png', createdAt: '2024-01-02T03:04:05.000Z', urls: imageUrls('https://cdn.test', HEX, 'a.png') });
    assert.deepEqual(toImage({ _id: id, name: 'Only name', insertDate: new Date(Number.NaN) }, null, HEX), { id: id.toHexString(), name: 'Only name', title: 'Only name', alt: '', companyId: null, extension: '', mimetype: null, createdAt: null, urls: null });
    assert.deepEqual(toImage({ name: 5, title: 5, insertDate: 'x' }, null, HEX), { id: '', name: '', title: '', alt: '', companyId: null, extension: '', mimetype: null, createdAt: null, urls: null });
  });

  it('builds the descriptor of a logo from a stored image, with the defaults of the legacy for what it lacks, and refuses a document that cannot be a logo', () => {
    const id = new ObjectId();
    const stored: Document = { _id: id, basename: 'a.png', extension: 'png', mimetype: 'image/png', filectime: new Double(1_700_000_000_000), name: 'N', title: 'T', alt: 'A', dirname: '/media/image' };
    const expected = { _id: id.toHexString(), basename: 'a.png', extension: 'png', filename: 'N', mimetype: 'image/png', title: 'T', alt: 'A', dirname: '/media/image', type: 'image', filectime: 1_700_000_000_000 };
    assert.deepEqual(toLogoSource(stored), expected);
    assert.deepEqual(toLogoSource({ _id: id, basename: 'a.png', extension: 'png', mimetype: 'image/png', filectime: 1_700_000_000_000 }), { ...expected, filename: 'a.png', title: 'a.png', alt: '' });
    assert.deepEqual(toLogoSource({ ...stored, dirname: 5, name: 5, title: 5, alt: 5 }), { ...expected, filename: 'a.png', title: 'a.png', alt: '' });
    assert.equal(toLogoSource({ ...stored, dirname: '/../0200000000000000000000ff/media/image' })?.dirname, '/media/image', 'the directory is never read from the document');
    assert.deepEqual(toLogoSource({ ...stored, filectime: 1_700_000_000_000 }), expected);
    const unsafe = ['../x.png', 'a/b.png', 'a\\b.png', 'a?b.png', 'a#b.png', 'a%2fb.png', '.hidden.png', 'a\nb.png', 'a\u0000b.png', 'x'.repeat(256), 'a..b.png'];
    for (const basename of unsafe) {
      assert.equal(toLogoSource({ ...stored, basename }), null, JSON.stringify(basename));
    }
    for (const mimetype of ['text/html', 'image/', 'image/svg xml', 'application/octet-stream', 'IMAGE', 'image/' + 'x'.repeat(70)]) {
      assert.equal(toLogoSource({ ...stored, mimetype }), null, mimetype);
    }
    for (const extension of ['p/ng', 'png.exe', '', 'x'.repeat(11)]) {
      assert.equal(toLogoSource({ ...stored, extension }), null, extension);
    }
    assert.ok(toLogoSource({ ...stored, mimetype: 'image/svg+xml' }) !== null, 'any image type of the legacy is accepted');
    for (const broken of [{ ...stored, _id: 'x' }, { ...stored, basename: undefined }, { ...stored, basename: '' }, { ...stored, extension: 5 }, { ...stored, mimetype: undefined }, { ...stored, filectime: 'x' }, { ...stored, filectime: undefined }]) {
      assert.equal(toLogoSource(broken), null);
    }
  });

  it('builds the document of a new image with the keys, the order and the types of the legacy', () => {
    const now = new Date('2024-11-13T10:00:00.123Z');
    const id = new ObjectId();
    const owner = new ObjectId();
    const company = new ObjectId();
    const document = newFileDocument({ id, groupId: GROUP, basename: 'a-1a2b3c4d.jpg', title: 'Caffè', extension: 'jpg', mimetype: 'image/jpeg', now, createdBy: owner, companyId: company });
    assert.deepEqual(Object.keys(document), ['_id', 'groupId', 'basename', 'name', 'extension', 'dirname', 'type', 'mimetype', 'filectime', 'alt', 'title', 'trash', 'insertDate', 'updateDate', 'createdBy', 'companyId']);
    assert.deepEqual([document['createdBy'], document['companyId']], [owner, company]);
    assert.equal(newFileDocument({ id, groupId: GROUP, basename: 'a.jpg', title: 'x', extension: 'jpg', mimetype: 'image/jpeg', now, createdBy: owner, companyId: null })['companyId'], null);
    assert.ok(document['filectime'] instanceof Double);
    assert.equal((document['filectime'] as Double).value, now.getTime());
    assert.deepEqual([document['name'], document['alt'], document['title'], document['dirname'], document['type'], document['trash'], document['insertDate'], document['updateDate']], ['Caffè', 'Caffè', 'Caffè', '/media/image', 'image', false, now, now]);
  });
});

describe('media service', () => {
  const COMPANY = new ObjectId('0123456789abcdef01234567');
  const OTHER = new ObjectId('0123456789abcdef01234568');
  const stored: Document = { _id: new ObjectId(), basename: 'a.png', name: 'N', extension: 'png', mimetype: 'image/png', filectime: 1_700_000_000_000 };
  const sa = (): AuthPrincipal => principalOf('SA', { groupId: GROUP });
  const ca = (): AuthPrincipal => principalOf('CA', { groupId: GROUP, companyIds: [COMPANY] });

  interface Setup {
    storage?: Partial<MediaStorage> | null;
    repository?: Partial<MediaRepository>;
    usable?: boolean;
    suffixes?: string[];
  }

  function setup(overrides: Setup = {}) {
    const calls: string[] = [];
    const inserted: Document[] = [];
    const filters: Array<Filter<Document>> = [];
    let generation = 0;
    const repository: MediaRepository = {
      insert: async (_p, _a, document) => void inserted.push(document),
      list: async (_p, _a, _params, visible) => (filters.push(visible), { items: [stored], page: { limit: 50, next: null } }),
      findImage: async (_p, _a, _id, visible) => (filters.push(visible), stored),
      hasFile: async () => false,
      filesHost: async () => 'https://cdn.test',
      ...overrides.repository,
    };
    const storage: MediaStorage | null =
      overrides.storage === null
        ? null
        : {
            upload: async (name) => (calls.push(`upload ${name}`), { generation: String(++generation) }),
            remove: async (name, gen) => void calls.push(`remove ${name} ${gen}`),
            removeIfSame: async (name) => void calls.push(`removeIfSame ${name}`),
            ...overrides.storage,
          };
    const { logger, events } = memoryLogger();
    const suffixes = [...(overrides.suffixes ?? [])];
    const service = createMediaService({
      repository,
      storage,
      logger,
      now: () => 1_731_490_000_000,
      randomSuffix: () => suffixes.shift() ?? 'deadbeef',
      companyUsable: async () => overrides.usable ?? true,
    });
    return { service, calls, inserted, events, filters };
  }

  const upload = async (service: MediaService, principal = sa(), companyId: ObjectId | null = null, name = 'a.png') => service.upload(principal, access, { buffer: await image('png', 400, 200), originalName: name }, companyId);
  const refusal = (code: string, details?: unknown) => (error: unknown) => error instanceof AppError && error.code === code && (details === undefined || JSON.stringify(error.details) === JSON.stringify(details));

  it('says whether the storage exists, and refuses to upload without it', async () => {
    assert.equal(setup().service.available, true);
    const off = setup({ storage: null });
    assert.equal(off.service.available, false);
    await assert.rejects(() => off.service.upload(sa(), access, { buffer: Buffer.alloc(1), originalName: 'a.png' }, null), refusal('SERVICE_UNAVAILABLE'));
  });

  it('refuses a file that is not an image by its bytes before touching the storage', async () => {
    const { service, calls } = setup();
    await assert.rejects(() => service.upload(sa(), access, { buffer: Buffer.from('<svg></svg>'), originalName: 'a.png' }, null), refusal('UNSUPPORTED_MEDIA_TYPE'));
    assert.deepEqual(calls, []);
  });

  it('uploads the five objects, then inserts the document with its owner, with the name built from the injected suffix', async () => {
    const { service, calls, inserted } = setup();
    const result = await upload(service, sa(), COMPANY, 'Logo Café.PNG');
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map((call) => call.replace(`upload ${HEX}/media/image/`, '')).sort(), IMAGE_SIZE_NAMES.map((size) => `${size}/logo-cafe-deadbeef.png`).sort());
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]!['basename'], 'logo-cafe-deadbeef.png');
    assert.deepEqual([inserted[0]!['createdBy'], inserted[0]!['companyId']], [principalOf('SA').userId, COMPANY]);
    assert.deepEqual([result.name, result.title, result.extension, result.companyId, result.urls?.s], ['Logo Café', 'Logo Café', 'png', COMPANY.toHexString(), `https://cdn.test/${HEX}/media/image/s/logo-cafe-deadbeef.png`]);
    assert.equal((await upload(service)).companyId, null, 'an image of the whole group');
  });

  it('asks a company administrator for his company, and checks the company for everybody', async () => {
    const { service, calls } = setup();
    await assert.rejects(() => upload(service, ca(), null), refusal('VALIDATION_ERROR', [{ field: 'companyId', issue: 'required' }]));
    await assert.rejects(() => upload(service, ca(), OTHER), refusal('NOT_FOUND'));
    assert.equal((await upload(service, ca(), COMPANY)).companyId, COMPANY.toHexString());
    const unusable = setup({ usable: false });
    await assert.rejects(() => upload(unusable.service, sa(), COMPANY), refusal('VALIDATION_ERROR', [{ field: 'companyId', issue: 'incorrect' }]));
    await assert.rejects(() => upload(unusable.service, ca(), COMPANY), refusal('VALIDATION_ERROR', [{ field: 'companyId', issue: 'incorrect' }]));
    assert.deepEqual(unusable.calls, [], 'nothing is decoded or stored for a company that cannot be used');
    assert.equal(calls.length, 5);
  });

  it('rolls back only what it stored, by generation, when an upload fails, and logs by operation, reason and status only', async () => {
    const failing = setup({
      storage: {
        upload: async (name) => {
          if (name.includes('/m/')) {
            throw new StorageError('upload', 'status', 503);
          }
          return { generation: name.includes('/xs/') ? '11' : '12' };
        },
        remove: async (name, gen) => {
          if (name.includes('/xs/')) {
            throw new Error('plain failure with https://secret.example/token');
          }
          void gen;
        },
      },
    });
    await assert.rejects(() => upload(failing.service), refusal('SERVICE_UNAVAILABLE'));
    assert.equal(failing.inserted.length, 0);
    assert.deepEqual(
      failing.events.map((event) => [event['msg'], event['operation'], event['reason'], event['status']]),
      [
        ['an uploaded object could not be removed after a failed upload', 'unknown', 'unknown', null],
        ['image upload to the storage failed', 'upload', 'status', 503],
      ],
    );
    assert.equal(JSON.stringify(failing.events).includes('secret.example'), false);
  });

  it('removes with the generation the objects it stored, and checks the bytes of the ones whose outcome is unknown', async () => {
    const calls: string[] = [];
    const { service } = setup({
      storage: {
        upload: async (name) => {
          if (name.includes('/s/')) {
            throw new StorageError('upload', 'timeout');
          }
          if (name.includes('/l/')) {
            throw new StorageError('upload', 'exists', 412);
          }
          return { generation: `g-${name.split('/')[3]!}` };
        },
        remove: async (name, gen) => void calls.push(`remove ${name.split('/')[3]!} ${gen}`),
        removeIfSame: async (name) => void calls.push(`removeIfSame ${name.split('/')[3]!}`),
      },
      suffixes: ['aaaaaaaa', 'bbbbbbbb'],
    });
    await assert.rejects(() => upload(service), refusal('SERVICE_UNAVAILABLE'));
    // First try: three stored (removed by generation), one unknown (checked by its bytes), one taken (left alone) -> another name; the second try fails the same way.
    assert.equal(calls.filter((call) => call.startsWith('remove ')).length, 6);
    assert.equal(calls.filter((call) => call.startsWith('removeIfSame')).length, 2);
    assert.ok(calls.includes('remove xs g-xs') && calls.includes('remove xl g-xl'));
    assert.equal(calls.some((call) => call.endsWith(' l') || call.includes('remove l ')), false, 'the object that was taken is never removed');
  });

  it('tries another name once when the name is taken, and succeeds', async () => {
    let taken = true;
    const { service, inserted, calls } = setup({
      storage: {
        upload: async (name) => {
          if (taken && name.includes('/xl/')) {
            taken = false;
            throw new StorageError('upload', 'exists', 412);
          }
          return { generation: '1' };
        },
      },
      suffixes: ['11111111', '22222222'],
    });
    await upload(service);
    assert.equal(inserted[0]!['basename'], 'a-22222222.png');
    assert.ok(calls.some((call) => call.startsWith('remove ') && call.includes('a-11111111')), 'the four objects stored under the first name are removed');
  });

  it('removes the objects and rethrows when the insert fails and the document is not there', async () => {
    const failure = new Error('insert failed');
    const { service, calls } = setup({ repository: { insert: async () => Promise.reject(failure) } });
    await assert.rejects(() => upload(service), (error: unknown) => error === failure);
    assert.equal(calls.filter((call) => call.startsWith('remove ')).length, 5);
  });

  it('keeps everything when the insert failed but the document is there (the answer was lost), and when that cannot be checked', async () => {
    const failure = new Error('lost answer');
    const present = setup({ repository: { insert: async () => Promise.reject(failure), hasFile: async () => true } });
    const result = await upload(present.service);
    assert.equal(result.name, 'a');
    assert.equal(present.calls.filter((call) => !call.startsWith('upload')).length, 0);
    const unknown = setup({ repository: { insert: async () => Promise.reject(failure), hasFile: async () => Promise.reject(new Error('down')) } });
    await assert.rejects(() => upload(unknown.service), (error: unknown) => error === failure);
    assert.equal(unknown.calls.filter((call) => !call.startsWith('upload')).length, 0, 'objects of a document that may exist are kept');
    assert.equal(unknown.events.at(-1)?.['msg'], 'the result of a failed image insert could not be checked, the uploaded objects are kept');
  });

  it('shows a company administrator only the images of his companies, and gives the logo source with the owner rule', async () => {
    const { service, filters } = setup();
    await service.list(ca(), access, {} as never);
    await service.list(sa(), access, { companyId: COMPANY } as never);
    await service.get(ca(), access, new ObjectId());
    await service.get(sa(), access, new ObjectId());
    assert.deepEqual(filters[0], { $and: [{ companyId: { $in: [COMPANY] } }] });
    assert.deepEqual(filters[1], { $and: [{}, { companyId: COMPANY }] });
    assert.deepEqual(filters[2], { companyId: { $in: [COMPANY] } });
    assert.deepEqual(filters[3], {});
    assert.equal((await service.logoSource(ca(), access, new ObjectId(), COMPANY))?.basename, 'a.png');
    assert.deepEqual(filters[4], { companyId: COMPANY });
    assert.equal(await service.logoSource(ca(), access, new ObjectId(), null), null);
    assert.equal(filters.length, 5, 'no read for a creation by a company administrator');
    assert.equal((await service.logoSource(sa(), access, new ObjectId(), null))?.basename, 'a.png');
    assert.deepEqual(filters[5], {});
  });

  it('lists, reads one and gives the logo source', async () => {
    const { service } = setup();
    const listing = await service.list(sa(), access, {} as never);
    assert.equal(listing.items[0]?.name, 'N');
    assert.deepEqual(listing.page, { limit: 50, next: null });
    assert.equal((await service.get(sa(), access, new ObjectId())).name, 'N');
    const missing = setup({ repository: { findImage: async () => null } }).service;
    await assert.rejects(() => missing.get(sa(), access, new ObjectId()), refusal('NOT_FOUND'));
    assert.equal(await missing.logoSource(sa(), access, new ObjectId(), COMPANY), null);
  });

  it('stops an upload at its deadline and builds the random suffix from the system by default', async () => {
    const calls: string[] = [];
    const { logger } = memoryLogger();
    const service = createMediaService({
      repository: { insert: async () => {}, list: async () => ({ items: [], page: { limit: 1, next: null } }), findImage: async () => null, hasFile: async () => false, filesHost: async () => null },
      storage: { upload: async (name, _b, _t, options) => (calls.push(name), options?.signal?.aborted === false ? { generation: '1' } : { generation: '0' }), remove: async () => {}, removeIfSame: async () => {} },
      logger,
      now: Date.now,
      companyUsable: async () => true,
      uploadDeadlineMs: 5000,
      rollbackDeadlineMs: 5000,
    });
    await service.upload(sa(), access, { buffer: await image('png'), originalName: 'x.png' }, null);
    assert.match(calls[0]!, /\/media\/image\/(?:xs|s|m|l|xl)\/x-[0-9a-f]{8}\.png$/);
  });
});
