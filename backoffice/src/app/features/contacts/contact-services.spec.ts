import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ApiError } from '../../core/api/api-error';
import {
  SEARCH_COMBOBOX_DEBOUNCE_MS,
  SearchCombobox,
} from '../../shared/ui/search-combobox/search-combobox';
import { ServiceRow } from './contact-model';
import { ContactServices, DEFAULT_DURATION, SERVICE_SEARCH_MIN_CHARS } from './contact-services';
import { CONTACT_LIMITS } from './contact.types';

const S1 = '665f1c2e9b1d4a0012ab3401';
const S2 = '665f1c2e9b1d4a0012ab3402';
const S3 = '665f1c2e9b1d4a0012ab3403';

@Component({
  imports: [ContactServices],
  template: `<fc-contact-services
    groupId="g1"
    [(value)]="value"
    [error]="error()"
    [disabled]="disabled()"
  />`,
})
class Host {
  readonly value = signal<ServiceRow[]>([
    { productId: S1, duration: '00:30' },
    { productId: S2, duration: '01:00' },
  ]);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
}

async function render(
  lookupNames: () => Promise<Record<string, string>> = async () => ({ [S1]: 'Haircut' }),
  value?: ServiceRow[],
) {
  const reference = { lookupNames: vi.fn(lookupNames) };
  TestBed.configureTestingModule({
    providers: [...provideApiTesting(), { provide: ReferenceApi, useValue: reference }],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  if (value) {
    fixture.componentInstance.value.set(value);
  }
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const rows = () => [...root.querySelectorAll<HTMLElement>('ul.rows > li')];
  const combobox = () => root.querySelector<HTMLInputElement>('input[role=combobox]')!;
  const options = () => [...root.querySelectorAll<HTMLElement>('[role=option]')];
  const search = async (text: string) => {
    const input = combobox();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, SEARCH_COMBOBOX_DEBOUNCE_MS + 50));
    await view();
  };
  const component = fixture.debugElement.children[0].componentInstance as ContactServices;
  return {
    fixture,
    host: fixture.componentInstance,
    root,
    view,
    rows,
    combobox,
    options,
    search,
    reference,
    component,
  };
}

const services = (...rows: { id: string; name: string | null; code?: string }[]) => ({
  data: rows.map((row) => ({ code: null, ...row })),
  page: { limit: 25, next: null },
});

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactServices', () => {
  it('shows the services with the names read once from the compact lookup, and their durations', async () => {
    const { rows, reference } = await render();
    expect(reference.lookupNames).toHaveBeenCalledTimes(1);
    expect(reference.lookupNames).toHaveBeenCalledWith('g1', 'products', [S1, S2]);
    expect(rows()).toHaveLength(2);
    expect(rows()[0].querySelector('.name')?.textContent).toBe('Haircut');
    expect(rows()[0].querySelector('input')!.value).toBe('00:30');
    expect(rows()[0].querySelector('input')!.type).toBe('text');
    expect(rows()[0].textContent).toContain('CONTACTS.SERVICES.DURATION_HINT');
    expect(rows()[0].querySelector('label')?.textContent?.trim()).toBe(
      'CONTACTS.SERVICES.DURATION {"name":"Haircut"}',
    );
  });

  it('falls back on the short id when the name is not known', async () => {
    const { rows } = await render();
    expect(rows()[1].querySelector('.name')?.textContent).toBe(`…${S2.slice(-6)}`);
  });

  it('falls back on the short id and logs only the code when the names cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rows } = await render(() =>
      Promise.reject(new ApiError({ code: 'INTERNAL_ERROR', status: 500, message: 'x' })),
    );
    expect(rows()[0].querySelector('.name')?.textContent).toBe(`…${S1.slice(-6)}`);
    expect(warn).toHaveBeenCalledWith('Cannot read the names of the services', 'INTERNAL_ERROR');
  });

  it('logs "unexpected" for a failure that is not an API error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await render(() => Promise.reject(new Error('url with ids')));
    expect(warn).toHaveBeenCalledWith('Cannot read the names of the services', 'unexpected');
  });

  it('does not look anything up when the contact has no services', async () => {
    const { reference, root } = await render(undefined, []);
    expect(reference.lookupNames).not.toHaveBeenCalled();
    expect(root.querySelector('li.note')?.textContent).toBe('CONTACTS.SERVICES.EMPTY');
  });

  it('searches the service products on the server only from two characters on', async () => {
    const { search, options, root, view } = await render();
    expect(SERVICE_SEARCH_MIN_CHARS).toBe(2);
    await search('h');
    backend().expectNone((r) => r.url.includes('/products'));
    expect(root.textContent).toContain('SEARCH_COMBOBOX.MIN_CHARS');
    await search('ha');
    const req = backend().expectOne((r) => r.url === `${API}/v1/groups/g1/products`);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('family')).toBe('services');
    expect(req.request.params.get('q')).toBe('ha');
    expect(req.request.params.get('limit')).toBe('25');
    req.flush(services({ id: S3, name: 'Hairdo' }, { id: S2, name: null, code: 'SV-9' }));
    await view();
    expect(options().map((o) => o.textContent?.trim())).toEqual(['Hairdo', 'SV-9']);
  });

  it('names a found service by its id when it has neither name nor code', async () => {
    const { search, options, view } = await render();
    await search('zz');
    backend()
      .expectOne((r) => r.url === `${API}/v1/groups/g1/products`)
      .flush(services({ id: S3, name: null }));
    await view();
    expect(options().map((o) => o.textContent?.trim())).toEqual([S3]);
  });

  it('adds the chosen service with the default duration and its name at once', async () => {
    const { search, options, view, host, rows, reference } = await render();
    await search('ha');
    backend()
      .expectOne((r) => r.url === `${API}/v1/groups/g1/products`)
      .flush(services({ id: S3, name: 'Hairdo' }));
    await view();
    options()[0].click();
    await view();
    expect(DEFAULT_DURATION).toBe('01:00');
    expect(host.value()).toEqual([
      { productId: S1, duration: '00:30' },
      { productId: S2, duration: '01:00' },
      { productId: S3, duration: '01:00' },
    ]);
    expect(rows()[2].querySelector('.name')?.textContent).toBe('Hairdo');
    expect(document.activeElement).toBe(rows()[2].querySelector('input'));
    expect(reference.lookupNames).toHaveBeenCalledTimes(1);
  });

  it('does not add a service the contact has already, nor an empty choice', async () => {
    const { search, options, view, host, combobox } = await render();
    await search('ha');
    backend()
      .expectOne((r) => r.url === `${API}/v1/groups/g1/products`)
      .flush(services({ id: S1, name: 'Haircut' }));
    await view();
    options()[0].click();
    await view();
    expect(host.value()).toHaveLength(2);
    expect(combobox()).toBeTruthy();
  });

  it('ignores the clearing of the choice', async () => {
    const { view, host, fixture } = await render();
    fixture.debugElement.query(By.directive(SearchCombobox)).componentInstance.choice.emit(null);
    await view();
    expect(host.value()).toHaveLength(2);
  });

  it('changes the duration of a row and shows the error of a wrong one', async () => {
    const { rows, view, host, reference } = await render();
    const input = rows()[0].querySelector('input')!;
    input.value = '02:15';
    input.dispatchEvent(new Event('input'));
    await view();
    expect(host.value()[0]).toEqual({ productId: S1, duration: '02:15' });
    expect(host.value()[1].duration).toBe('01:00');
    expect(rows()[0].querySelector('[role=alert]')).toBeNull();
    expect(rows()[0].querySelector('.name')?.textContent).toBe('Haircut');
    expect(reference.lookupNames).toHaveBeenCalledTimes(1);
    input.value = '00:00';
    input.dispatchEvent(new Event('input'));
    await view();
    expect(rows()[0].textContent).toContain('FORM.ISSUE.INCORRECT');
    expect(rows()[1].textContent).not.toContain('FORM.ISSUE.INCORRECT');
  });

  it('removes a service', async () => {
    const { rows, view, host } = await render();
    const remove = rows()[0].querySelector('button')!;
    expect(remove.getAttribute('aria-label')).toBe('CONTACTS.LIST.REMOVE_LABEL {"name":"Haircut"}');
    remove.click();
    await view();
    expect(host.value()).toEqual([{ productId: S2, duration: '01:00' }]);
    expect(rows()).toHaveLength(1);
    expect(document.activeElement).toBe(rows()[0].querySelector('input'));
  });

  it('focuses the previous row when the last one is removed', async () => {
    const { rows, view } = await render();
    rows()[1].querySelector('button')!.click();
    await view();
    expect(document.activeElement).toBe(rows()[0].querySelector('input'));
  });

  it('shows the error of the whole list', async () => {
    const { root, view, host } = await render();
    host.error.set('Service twice');
    await view();
    const alert = root.querySelector('p.problem')!;
    expect(alert.textContent).toBe('Service twice');
    expect(root.querySelector('fieldset')?.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('says the limit has been reached', async () => {
    const { root, view, host } = await render();
    expect(root.querySelector('p.note')).toBeNull();
    expect(root.querySelector('fc-search-combobox')).not.toBeNull();
    host.value.set(
      Array.from({ length: CONTACT_LIMITS.services }, (_, i) => ({
        productId: `P${i}`,
        duration: '01:00',
      })),
    );
    await view();
    expect(root.textContent).toContain(
      `CONTACTS.SERVICES.LIMIT {"max":${CONTACT_LIMITS.services}}`,
    );
    expect(root.querySelector('fc-search-combobox')).toBeNull();
  });

  it('is read only when disabled: no search, no remove', async () => {
    const { rows, root, view, host } = await render();
    host.disabled.set(true);
    await view();
    expect(rows()[0].querySelector('input')!.disabled).toBe(true);
    expect(root.querySelector('button')).toBeNull();
    expect(root.querySelector('fc-search-combobox')).toBeNull();
  });

  it('focuses the first duration', async () => {
    const { rows, component } = await render();
    component.focus();
    expect(document.activeElement).toBe(rows()[0].querySelector('input'));
  });

  it('focuses the search when there is no row', async () => {
    const { component, view } = await render(undefined, []);
    component.focus();
    await view();
    backend()
      .match((r) => r.url === `${API}/v1/groups/g1/products`)
      .forEach((req) => req.flush(services()));
    expect(document.activeElement).toBe(document.body.querySelector('input[role=combobox]'));
  });
});
