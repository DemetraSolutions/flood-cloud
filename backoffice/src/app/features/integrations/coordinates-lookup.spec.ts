import { API, backend, errorBody } from '../../../testing/api';
import { cleanUpIntegrations, mountIntegration } from '../../../testing/integrations';
import { CoordinatesLookup } from './coordinates-lookup';

const URL = `${API}/v1/groups/g1/places/p1/geocoding`;
const ADDRESS = {
  street: ' Via Roma 1 ',
  postcode: '20100',
  city: 'Milano',
  province: 'MI',
  country: 'IT',
};
const CALC = 'INTEGRATIONS.COORDINATES.CALCULATE';

afterEach(cleanUpIntegrations);

const open = (inputs: object = {}, geocoding = true) =>
  mountIntegration(
    CoordinatesLookup,
    { groupId: 'g1', placeId: 'p1', address: ADDRESS, ...inputs },
    { providers: { geocoding } },
  );
type View = Awaited<ReturnType<typeof open>>;
const alerts = (view: View) =>
  [...view.root.querySelectorAll('p[role="alert"]')].map((p) => p.textContent?.trim());

async function fail(code: string, status: number, details?: { field: string; issue: string }[]) {
  const view = await open();
  await view.click(CALC);
  backend().expectOne(URL).flush(errorBody(code, details), { status, statusText: code });
  await view.view();
  return view;
}

describe('CoordinatesLookup', () => {
  it('shows nothing when the geocoding is not configured', async () => {
    expect((await open({}, false)).button(CALC)).toBeUndefined();
  });

  it('shows nothing for a place not created yet', async () => {
    expect((await open({ placeId: undefined })).button(CALC)).toBeUndefined();
  });

  it('sends the trimmed address and hands the coordinates to the page', async () => {
    const view = await open();
    const located = vi.fn();
    view.component.located.subscribe(located);
    await view.click(CALC);
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ ...ADDRESS, street: 'Via Roma 1' });
    expect(view.button(CALC)?.getAttribute('aria-busy')).toBe('true');
    request.flush({ data: { lat: 45.46, lng: 9.19 } });
    await view.view();
    expect(located).toHaveBeenCalledExactlyOnceWith({ lat: 45.46, lng: 9.19 });
    expect(view.root.textContent).toContain('INTEGRATIONS.COORDINATES.DONE');
    await view.click(CALC);
    expect(view.root.textContent).not.toContain('INTEGRATIONS.COORDINATES.DONE');
    backend().expectOne(URL).flush({ data: { lat: 1, lng: 2 } });
    await view.view();
  });

  it('lists the missing fields of the address and calls nothing', async () => {
    const view = await open({ address: { ...ADDRESS, street: '  ', city: '' } });
    await view.click(CALC);
    backend().expectNone(URL);
    expect(alerts(view)).toEqual([
      'INTEGRATIONS.COORDINATES.MISSING {"fields":"INTEGRATIONS.COORDINATES.FIELD.STREET, INTEGRATIONS.COORDINATES.FIELD.CITY"}',
    ]);
  });

  it('forgets the warning when the address is complete', async () => {
    const view = await open({ address: { ...ADDRESS, city: '' } });
    await view.click(CALC);
    view.fixture.componentRef.setInput('address', ADDRESS);
    await view.view();
    await view.click(CALC);
    backend().expectOne(URL).flush({ data: { lat: 1, lng: 2 } });
    await view.view();
    expect(alerts(view)).toEqual([]);
  });

  it('cannot run while the page says it is blocked', async () => {
    const view = await open({ blockedBy: 'No' });
    expect(view.button(CALC)?.disabled).toBe(true);
    expect(view.root.textContent).toContain('No');
  });

  it('says no coordinate was found for an address the provider does not know', async () => {
    const view = await fail('VALIDATION_ERROR', 422, [{ field: 'street', issue: 'incorrect' }]);
    expect(alerts(view)).toEqual(['INTEGRATIONS.COORDINATES.NOT_FOUND']);
  });

  it.each([
    ['VALIDATION_ERROR', 422, [{ field: 'city', issue: 'required' }], 'INTEGRATIONS.INVALID'],
    ['VALIDATION_ERROR', 422, [{ field: 'street', issue: 'required' }], 'INTEGRATIONS.INVALID'],
    ['PROVIDER_ERROR', 502, undefined, 'INTEGRATIONS.PROVIDER_ERROR'],
    ['SERVICE_UNAVAILABLE', 503, undefined, 'INTEGRATIONS.UNAVAILABLE'],
    ['RATE_LIMITED', 429, undefined, 'ERRORS.API.RATE_LIMITED'],
  ])('shows %s %j', async (code, status, details, text) => {
    const view = await fail(code, status, details);
    expect(alerts(view)).toEqual([text]);
    backend().expectNone(URL);
  });
});
