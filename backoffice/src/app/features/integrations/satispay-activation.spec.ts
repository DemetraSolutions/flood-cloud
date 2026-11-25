import { API, backend, errorBody, settle } from '../../../testing/api';
import { cleanUpIntegrations, mountIntegration } from '../../../testing/integrations';
import { SatispayActivation } from './satispay-activation';

const URL = `${API}/v1/groups/g1/places/p1/integrations/satispay/activation`;
const INPUTS = { groupId: 'g1', placeId: 'p1', etag: '"v1"' };
const CODE_LABEL = 'INTEGRATIONS.SATISPAY.CODE';
const ACTIVATE = 'INTEGRATIONS.SATISPAY.ACTIVATE';

afterEach(cleanUpIntegrations);

const open = (
  options: { role?: 'PSA' | 'D' | 'SA' | 'CA' | 'PA'; satispay?: boolean; inputs?: object } = {},
) =>
  mountIntegration(
    SatispayActivation,
    { ...INPUTS, ...options.inputs },
    { role: options.role, providers: { satispay: options.satispay ?? true } },
  );

type View = Awaited<ReturnType<typeof open>>;

const input = (view: View) =>
  view.root.querySelector<HTMLInputElement>('input') as HTMLInputElement;

async function type(view: View, value: string) {
  const field = input(view);
  field.value = value;
  field.dispatchEvent(new Event('input'));
  await view.view();
}

const alert = (view: View) => view.root.querySelector('p[role="alert"]')?.textContent?.trim();
const fieldError = (view: View) => view.root.querySelector('[id$="-error"]')?.textContent?.trim();

/** Types the code, presses the button and returns the request. */
async function send(view: View, code = 'AB12CD') {
  await type(view, code);
  await view.click(ACTIVATE);
  return backend().expectOne(URL);
}

function failWith(
  request: ReturnType<ReturnType<typeof backend>['expectOne']>,
  code: string,
  status: number,
  options: { details?: { field: string; issue: string }[]; headers?: Record<string, string> } = {},
) {
  request.flush(errorBody(code, options.details), {
    status,
    statusText: code,
    headers: options.headers,
  });
}

describe('SatispayActivation', () => {
  describe('who sees it', () => {
    it.each(['PSA', 'D'] as const)('shows the code and the button to a %s', async (role) => {
      const view = await open({ role });
      expect(input(view)).not.toBeNull();
      expect(view.button(ACTIVATE)).toBeDefined();
    });

    it.each(['SA', 'CA', 'PA'] as const)('shows nothing to a %s', async (role) => {
      const view = await open({ role });
      expect(view.root.querySelector('section')).toBeNull();
    });

    it('shows nothing when Satispay is not configured on the platform', async () => {
      const view = await open({ satispay: false });
      expect(view.root.querySelector('section')).toBeNull();
    });

    it('shows nothing for a place that does not exist yet', async () => {
      const view = await open({ inputs: { placeId: undefined } });
      expect(view.root.querySelector('section')).toBeNull();
    });
  });

  it('labels the field and never takes a password manager for it', async () => {
    const view = await open();
    const field = input(view);
    expect(view.root.querySelector(`label[for="${field.id}"]`)?.textContent?.trim()).toBe(CODE_LABEL);
    expect(field.autocomplete).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
  });

  describe('the attempt', () => {
    it('posts the code with a key and the version, and hands the new version to the page', async () => {
      const view = await open();
      const activated = vi.fn();
      view.component.activated.subscribe(activated);
      const request = await send(view, ' ab12cd ');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ activationCode: 'ab12cd' });
      expect(request.request.headers.get('If-Match')).toBe('"v1"');
      expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(view.button(ACTIVATE)?.getAttribute('aria-busy')).toBe('true');
      request.flush({ data: { keyIdSet: true } }, { headers: { ETag: '"v2"' } });
      await view.view();
      expect(activated).toHaveBeenCalledExactlyOnceWith('"v2"');
      expect(input(view).value).toBe('');
      expect(view.button(ACTIVATE)?.getAttribute('aria-busy')).toBeNull();
      expect(alert(view)).toBeUndefined();
    });

    it('says the place must be read again when the answer has no version', async () => {
      const view = await open();
      const activated = vi.fn();
      view.component.activated.subscribe(activated);
      (await send(view)).flush({ data: { keyIdSet: true } });
      await view.view();
      expect(activated).toHaveBeenCalledExactlyOnceWith(null);
    });

    it('marks the field as touched when it loses the focus', async () => {
    const view = await open();
    input(view).dispatchEvent(new Event('blur'));
    await view.view();
    expect(fieldError(view)).toBe('FORM.ISSUE.REQUIRED');
  });

  it('presses the button with Enter', async () => {
      const view = await open();
      await type(view, 'AB12CD');
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      input(view).dispatchEvent(event);
      await view.view();
      expect(event.defaultPrevented).toBe(true);
      backend().expectOne(URL).flush({ data: { keyIdSet: true } });
      await view.view();
    });

    it('sends nothing without a code or with characters a code never has', async () => {
      const view = await open();
      await view.click(ACTIVATE);
      expect(fieldError(view)).toBe('FORM.ISSUE.REQUIRED');
      await type(view, 'AB-12 CD');
      await view.click(ACTIVATE);
      expect(fieldError(view)).toBe('FORM.ISSUE.PATTERN');
      backend().expectNone(URL);
    });

    it('cannot run while the page says it is blocked, with the button or with Enter, and says why', async () => {
      const view = await open({ inputs: { blockedBy: 'Salva prima' } });
      expect(view.button(ACTIVATE)?.disabled).toBe(true);
      expect(view.root.textContent).toContain('Salva prima');
      await type(view, 'AB12CD');
      input(view).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await view.view();
      backend().expectNone(URL);
    });

    it('sends no version when the page has none', async () => {
      const view = await open({ inputs: { etag: null } });
      const request = await send(view);
      expect(request.request.headers.has('If-Match')).toBe(false);
      request.flush({ data: { keyIdSet: true } });
      await view.view();
    });
  });

  describe('the Idempotency-Key', () => {
    const keyOf = (request: { request: { headers: { get(name: string): string | null } } }) =>
      request.request.headers.get('Idempotency-Key');

    it.each([
      ['a network failure', 0, 'NETWORK_ERROR'],
      ['a server error', 500, 'INTERNAL_ERROR'],
      ['an unreachable provider', 502, 'PROVIDER_ERROR'],
    ])('is reused when the user repeats the same code after %s', async (_name, status, code) => {
      const view = await open();
      const first = await send(view);
      const key = keyOf(first);
      if (status === 0) {
        first.error(new ProgressEvent('error'));
      } else {
        failWith(first, code, status);
      }
      await view.view();
      await view.click(ACTIVATE);
      const second = backend().expectOne(URL);
      expect(keyOf(second)).toBe(key);
      second.flush({ data: { keyIdSet: true } });
      await view.view();
    });

    it.each([
      ['a refused code', 422, 'VALIDATION_ERROR'],
      ['a place changed meanwhile', 412, 'PRECONDITION_FAILED'],
      ['a rate limit', 429, 'RATE_LIMITED'],
    ])('is new after %s', async (_name, status, code) => {
      const view = await open();
      const first = await send(view);
      const key = keyOf(first);
      failWith(first, code, status);
      await view.view();
      await view.click(ACTIVATE);
      const second = backend().expectOne(URL);
      expect(keyOf(second)).not.toBe(key);
      second.flush({ data: { keyIdSet: true } });
      await view.view();
    });

    it('is new for another code and after a success', async () => {
      const view = await open();
      const first = await send(view, 'AAA111');
      const key = keyOf(first);
      first.flush({ data: { keyIdSet: true } });
      await view.view();
      const again = await send(view, 'AAA111');
      expect(keyOf(again)).not.toBe(key);
      failWith(again, 'PROVIDER_ERROR', 502);
      await view.view();
      await type(view, 'BBB222');
      await view.click(ACTIVATE);
      const other = backend().expectOne(URL);
      expect(keyOf(other)).not.toBe(keyOf(again));
      other.flush({ data: { keyIdSet: true } });
      await view.view();
    });
  });

  describe('failures', () => {
    it('shows a refused code under the field and keeps it', async () => {
      const view = await open();
      failWith(await send(view), 'VALIDATION_ERROR', 422, {
        details: [{ field: 'activationCode', issue: 'incorrect' }],
      });
      await view.view();
      expect(fieldError(view)).toBe('INTEGRATIONS.CODE_REFUSED');
      expect(alert(view)).toBeUndefined();
      expect(input(view).value).toBe('AB12CD');
    });

    it('shows the issue of the code the server found', async () => {
      const view = await open();
      failWith(await send(view), 'VALIDATION_ERROR', 422, {
        details: [{ field: 'activationCode', issue: 'format' }],
      });
      await view.view();
      expect(fieldError(view)).toBe('FORM.ISSUE.FORMAT');
    });

    it.each([
      [
        'a switch that is off',
        { details: [{ field: 'integrations.satispay.status', issue: 'incorrect' }] },
        'INTEGRATIONS.DISABLED',
      ],
      [
        'a validation error without details',
        {},
        'INTEGRATIONS.INVALID',
      ],
    ])('shows %s as an alert', async (_name, options, text) => {
      const view = await open();
      failWith(await send(view), 'VALIDATION_ERROR', 422, options);
      await view.view();
      expect(alert(view)).toBe(text);
    });

    it.each([
      ['PROVIDER_ERROR', 502, 'INTEGRATIONS.PROVIDER_ERROR'],
      ['SERVICE_UNAVAILABLE', 503, 'INTEGRATIONS.UNAVAILABLE'],
      ['FORBIDDEN', 403, 'ERRORS.API.FORBIDDEN'],
    ])('shows %s as an alert and does not retry by itself', async (code, status, text) => {
      const view = await open();
      failWith(await send(view), code, status);
      await view.view();
      expect(alert(view)).toBe(text);
      await settle();
      backend().expectNone(URL);
    });

    it('tells how long to wait after a 429', async () => {
      const view = await open();
      failWith(await send(view), 'RATE_LIMITED', 429, { headers: { 'Retry-After': '30' } });
      await view.view();
      expect(alert(view)).toContain('ERRORS.API.RATE_LIMITED_WAIT');
    });

    it('invites to read the place again after a 412 and tells the page', async () => {
      const view = await open();
      const stale = vi.fn();
      view.component.stale.subscribe(stale);
      failWith(await send(view), 'PRECONDITION_FAILED', 412);
      await view.view();
      expect(alert(view)).toBe('INTEGRATIONS.STALE');
      expect(stale).toHaveBeenCalledOnce();
    });

    it('clears the message of the previous attempt when the next starts', async () => {
      const view = await open();
      failWith(await send(view), 'PROVIDER_ERROR', 502);
      await view.view();
      await view.click(ACTIVATE);
      expect(alert(view)).toBeUndefined();
      backend().expectOne(URL).flush({ data: { keyIdSet: true } });
      await view.view();
    });
  });
});
