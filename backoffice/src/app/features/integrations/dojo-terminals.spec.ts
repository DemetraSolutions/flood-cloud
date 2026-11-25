import { API, backend, failRequest } from '../../../testing/api';
import { cleanUpIntegrations, mountIntegration } from '../../../testing/integrations';
import { DojoTerminals } from './dojo-terminals';

const URL = `${API}/v1/groups/g1/places/p1/integrations/dojo/terminals`;
const INPUTS = { groupId: 'g1', placeId: 'p1' };
const LOAD = 'INTEGRATIONS.DOJO.LOAD';
const TERMINALS = [
  { id: 'terminal-id-1', tid: 'T-001', status: 'Active' },
  { id: 'terminal-id-2', tid: 'T-002', status: 'Inactive' },
];

afterEach(cleanUpIntegrations);

const open = (inputs: Record<string, unknown> = INPUTS, providers = { dojo: true }) =>
  mountIntegration(DojoTerminals, inputs, { providers });

describe('DojoTerminals', () => {
  it('shows nothing when Dojo is not configured on the platform', async () => {
    const view = await open(INPUTS, { dojo: false });
    expect(view.root.querySelector('section')).toBeNull();
    expect(view.button(LOAD)).toBeUndefined();
  });

  it('shows nothing for a place that does not exist yet', async () => {
    const view = await open({ groupId: 'g1', placeId: undefined });
    expect(view.button(LOAD)).toBeUndefined();
  });

  it('shows nothing until the availability is known', async () => {
    const view = await mountIntegration(DojoTerminals, INPUTS, {
      providers: { dojo: true },
      answer: false,
    });
    expect(view.button(LOAD)).toBeUndefined();
    backend()
      .expectOne(`${API}/v1/integrations`)
      .flush({ data: { dojo: true } });
    await view.view();
    expect(view.button(LOAD)).toBeDefined();
  });

  it('reads nothing until the user asks, then lists the terminals', async () => {
    const view = await open();
    backend().expectNone(URL);
    expect(view.root.querySelector('table')).toBeNull();
    await view.click(LOAD);
    expect(view.button(LOAD)?.getAttribute('aria-busy')).toBe('true');
    const request = backend().expectOne(URL);
    expect(request.request.method).toBe('GET');
    request.flush({ data: TERMINALS });
    await view.view();
    expect(view.button(LOAD)?.getAttribute('aria-busy')).toBeNull();
    const rows = [...view.root.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td, th')].map((cell) => cell.textContent?.trim()),
    );
    expect(rows).toEqual([
      ['terminal-id-1', 'T-001', 'Active', 'INTEGRATIONS.DOJO.COPY'],
      ['terminal-id-2', 'T-002', 'Inactive', 'INTEGRATIONS.DOJO.COPY'],
    ]);
    expect(view.root.textContent).toContain('INTEGRATIONS.DOJO.HINT');
  });

  it('reads the list again on every later press', async () => {
    const view = await open();
    await view.click(LOAD);
    backend().expectOne(URL).flush({ data: [] });
    await view.view();
    await view.click(LOAD);
    backend().expectOne(URL).flush({ data: TERMINALS });
    await view.view();
    expect(view.root.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('says there are no terminals', async () => {
    const view = await open();
    await view.click(LOAD);
    backend().expectOne(URL).flush({ data: [] });
    await view.view();
    expect(view.root.textContent).toContain('INTEGRATIONS.DOJO.EMPTY');
    expect(view.root.querySelector('p[role="alert"]')).toBeNull();
  });

  it('shows what the provider listed as text, never as markup', async () => {
    const view = await open();
    await view.click(LOAD);
    backend()
      .expectOne(URL)
      .flush({ data: [{ id: '<img src=x onerror=alert(1)>', tid: '<b>T</b>', status: '<i>x</i>' }] });
    await view.view();
    expect(view.root.querySelector('img, b, i')).toBeNull();
    expect(view.root.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  describe('copying the id', () => {
    const writeText = vi.fn();
    beforeEach(() => {
      writeText.mockReset();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    });

    async function listed() {
      const view = await open();
      await view.click(LOAD);
      backend().expectOne(URL).flush({ data: TERMINALS });
      await view.view();
      return view;
    }

    it('copies the id of the row and announces it, with a label that names the terminal', async () => {
      writeText.mockResolvedValue(undefined);
      const view = await listed();
      const buttons = view.root.querySelectorAll<HTMLButtonElement>('tbody button');
      expect(buttons[1].getAttribute('aria-label')).toBe(
        'INTEGRATIONS.DOJO.COPY_LABEL {"tid":"T-002"}',
      );
      buttons[1].click();
      await view.view();
      expect(writeText).toHaveBeenCalledWith('terminal-id-2');
      const status = view.root.querySelector('p[role="status"]');
      expect(status?.textContent).toContain('INTEGRATIONS.DOJO.COPIED {"tid":"T-002"}');
    });

    it('says so when the browser refuses to copy', async () => {
      const error = new Error('denied');
      writeText.mockRejectedValue(error);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const view = await listed();
      view.root.querySelector<HTMLButtonElement>('tbody button')!.click();
      await view.view();
      expect(logged).toHaveBeenCalledWith(error);
      const status = view.root.querySelector('p[role="status"]');
      expect(status?.textContent).toContain('INTEGRATIONS.DOJO.COPY_FAILED');
    });

    it('forgets the announcement when the list is read again', async () => {
      writeText.mockResolvedValue(undefined);
      const view = await listed();
      view.root.querySelector<HTMLButtonElement>('tbody button')!.click();
      await view.view();
      await view.click(LOAD);
      backend().expectOne(URL).flush({ data: TERMINALS });
      await view.view();
      expect(view.root.querySelector('p[role="status"]')?.textContent?.trim()).toBe('');
    });
  });

  describe('failures', () => {
    async function fail(code: string, options: Parameters<typeof failRequest>[3] = {}) {
      const view = await open();
      await view.click(LOAD);
      failRequest(backend(), '/v1/groups/g1/places/p1/integrations/dojo/terminals', code, options);
      await view.view();
      return view;
    }
    const alert = (root: HTMLElement) => root.querySelector('p[role="alert"]')?.textContent?.trim();

    it.each([
      ['PROVIDER_ERROR', undefined, 'INTEGRATIONS.PROVIDER_ERROR'],
      ['SERVICE_UNAVAILABLE', undefined, 'INTEGRATIONS.UNAVAILABLE'],
      ['FORBIDDEN', undefined, 'ERRORS.API.FORBIDDEN'],
      [
        'VALIDATION_ERROR',
        [{ field: 'integrations.dojo.status', issue: 'incorrect' }],
        'INTEGRATIONS.DISABLED',
      ],
      [
        'VALIDATION_ERROR',
        [{ field: 'integrations.dojo.apiKey', issue: 'required' }],
        'INTEGRATIONS.CREDENTIAL_MISSING',
      ],
      [
        'VALIDATION_ERROR',
        [{ field: 'integrations.dojo.apiKey', issue: 'incorrect' }],
        'INTEGRATIONS.CREDENTIAL_REFUSED',
      ],
    ])('shows the message of %s %j as an alert and no table', async (code, details, text) => {
      const view = await fail(code, { details });
      expect(alert(view.root)).toBe(text);
      expect(view.root.querySelector('table')).toBeNull();
    });

    it('tells how long to wait after a 429', async () => {
      const view = await fail('RATE_LIMITED', { headers: { 'Retry-After': '120' } });
      expect(alert(view.root)).toContain('ERRORS.API.RATE_LIMITED_WAIT');
    });

    it('does not retry by itself, and the user can ask again', async () => {
      const view = await fail('PROVIDER_ERROR');
      backend().expectNone(URL);
      await view.click(LOAD);
      backend().expectOne(URL).flush({ data: TERMINALS });
      await view.view();
      expect(alert(view.root)).toBeUndefined();
      expect(view.root.querySelectorAll('tbody tr')).toHaveLength(2);
    });
  });

  it('cannot run while the page says it is blocked, and says why', async () => {
    const view = await open({ ...INPUTS, blockedBy: 'Salva prima' });
    expect(view.button(LOAD)?.disabled).toBe(true);
    expect(view.root.textContent).toContain('Salva prima');
  });
});
