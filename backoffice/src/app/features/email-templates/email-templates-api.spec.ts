import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { EmailTemplatesApi } from './email-templates-api';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const ID = '665f1c2e9b1d4a0012ab34c1';
const URL = `${API}/v1/groups/${GROUP}/email-templates`;
const RECORD = { id: ID, name: 'N', text: 't', html: '<p>h</p>', createdAt: null, updatedAt: null };

function api(): EmailTemplatesApi {
  TestBed.configureTestingModule({ providers: [...provideApiTesting()] });
  return TestBed.inject(EmailTemplatesApi);
}

afterEach(() => backend().verify());

describe('EmailTemplatesApi', () => {
  it('builds the URLs encoding the ids', () => {
    const service = api();
    expect(service.baseUrl('a/b')).toBe('/v1/groups/a%2Fb/email-templates');
    expect(service.templateUrl('g', 't?')).toBe('/v1/groups/g/email-templates/t%3F');
  });

  it('reads one template with its version', async () => {
    const reading = api().read(GROUP, ID);
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('GET');
    request.flush({ data: RECORD }, { headers: { ETag: '"v1"' } });
    expect(await reading).toEqual({ template: RECORD, etag: '"v1"' });
  });

  it('creates a template with an Idempotency-Key', async () => {
    const creating = api().create(GROUP, { name: 'N' }, 'key-1');
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Idempotency-Key')).toBe('key-1');
    expect(request.request.body).toEqual({ name: 'N' });
    request.flush({ data: RECORD }, { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } });
    expect((await creating).etag).toBe('"v1"');
  });

  it('updates with the version in If-Match, and without it when there is none', async () => {
    const service = api();
    const first = service.update(GROUP, ID, { html: '<p>x</p>' }, '"v1"');
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    request.flush({ data: RECORD }, { headers: { ETag: '"v2"' } });
    expect((await first).etag).toBe('"v2"');
    const second = service.update(GROUP, ID, { name: 'M' }, null);
    const bare = backend().expectOne(`${URL}/${ID}`);
    expect(bare.request.headers.has('If-Match')).toBe(false);
    bare.flush({ data: RECORD });
    expect((await second).etag).toBeNull();
  });

  it('deletes a template', async () => {
    const removing = api().remove(GROUP, ID);
    const request = backend().expectOne(`${URL}/${ID}`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await removing;
  });
});
