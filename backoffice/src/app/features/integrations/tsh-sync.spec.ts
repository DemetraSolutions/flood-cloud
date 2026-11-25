import { API, backend, errorBody } from '../../../testing/api';
import { cleanUpIntegrations, mountIntegration } from '../../../testing/integrations';
import { TshSync } from './tsh-sync';

const URL = `${API}/v1/groups/g1/places/p1/integrations/tsh/charge-categories/sync`;
const INPUTS = { groupId: 'g1', placeId: 'p1', etag: '"v1"' };
const SYNC = 'INTEGRATIONS.TSH.SYNC';

afterEach(cleanUpIntegrations);

const open = (inputs: object = {}, tsh = true) =>
  mountIntegration(TshSync, { ...INPUTS, ...inputs }, { providers: { tsh } });
type View = Awaited<ReturnType<typeof open>>;
const alert = (view: View) => view.root.querySelector('p[role="alert"]')?.textContent?.trim();

async function fail(code: string, status: number, details?: { field: string; issue: string }[], headers?: Record<string, string>) {
  const view = await open();
  await view.click(SYNC);
  backend().expectOne(URL).flush(errorBody(code, details), { status, statusText: code, headers });
  await view.view();
  return view;
}

describe('TshSync', () => {
  it('shows nothing when TS Hospitality is not configured', async () => {
    expect((await open({}, false)).button(SYNC)).toBeUndefined();
  });

  it('shows nothing for a place not created yet', async () => {
    expect((await open({ placeId: undefined })).button(SYNC)).toBeUndefined();
  });

  it('downloads the categories with the version and hands them to the page', async () => {
    const view = await open();
    const synced = vi.fn();
    view.component.synced.subscribe(synced);
    await view.click(SYNC);
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(view.button(SYNC)?.getAttribute('aria-busy')).toBe('true');
    const categories = [{ id: 'T1', name: 'Bar' }];
    request.flush({ data: categories }, { headers: { ETag: '"v2"' } });
    await view.view();
    expect(synced).toHaveBeenCalledExactlyOnceWith({ categories, etag: '"v2"' });
    expect(view.root.querySelector('p[role="status"]')?.textContent).toContain(
      'INTEGRATIONS.TSH.DONE {"count":1}',
    );
    await view.click(SYNC);
    expect(view.root.querySelector('p[role="status"]')?.textContent?.trim()).toBe('');
    backend().expectOne(URL).flush({ data: [] });
    await view.view();
  });

  it('cannot run while the page says it is blocked, and says why', async () => {
    const view = await open({ blockedBy: 'Salva prima' });
    expect(view.button(SYNC)?.disabled).toBe(true);
    expect(view.root.textContent).toContain('Salva prima');
  });

  it.each([
    ['PROVIDER_ERROR', 502, 'INTEGRATIONS.PROVIDER_ERROR'],
    ['SERVICE_UNAVAILABLE', 503, 'INTEGRATIONS.UNAVAILABLE'],
  ])('shows %s and does not retry by itself', async (code, status, text) => {
    const view = await fail(code, status);
    expect(alert(view)).toBe(text);
    backend().expectNone(URL);
  });

  it.each([
    [[{ field: 'integrations.tsh.status', issue: 'incorrect' }], 'INTEGRATIONS.DISABLED'],
    [[{ field: 'integrations.tsh.secret', issue: 'required' }], 'INTEGRATIONS.CREDENTIAL_MISSING'],
    [[{ field: 'integrations.tsh.secret', issue: 'incorrect' }], 'INTEGRATIONS.CREDENTIAL_REFUSED'],
  ])('shows the 422 %j', async (details, text) => {
    expect(alert(await fail('VALIDATION_ERROR', 422, details))).toBe(text);
  });

  it('tells how long to wait after a 429', async () => {
    expect(alert(await fail('RATE_LIMITED', 429, undefined, { 'Retry-After': '60' }))).toContain(
      'ERRORS.API.RATE_LIMITED_WAIT',
    );
  });

  it('tells the page when the place changed meanwhile', async () => {
    const view = await open();
    const stale = vi.fn();
    view.component.stale.subscribe(stale);
    await view.click(SYNC);
    backend().expectOne(URL).flush(errorBody('PRECONDITION_FAILED'), { status: 412, statusText: 'x' });
    await view.view();
    expect(stale).toHaveBeenCalledOnce();
    expect(alert(view)).toBe('INTEGRATIONS.STALE');
  });
});
