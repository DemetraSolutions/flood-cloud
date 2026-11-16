import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { ETAG, GROUP, PLACE, fakeListItem, fakePlace } from '../../../testing/places';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PlaceRenewal } from './place-renewal';
import { PlaceListItem } from './place.types';

const URL = `${API}/v1/groups/${GROUP}/places/${PLACE}`;
const LABEL = 'PLACES.RENEW.LABEL {"name":"Bar Roma"}';

async function render(place: PlaceListItem = fakeListItem()) {
  TestBed.configureTestingModule({ providers: [provideApiTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(PlaceRenewal);
  fixture.componentRef.setInput('groupId', GROUP);
  fixture.componentRef.setInput('place', place);
  const renewed = vi.fn();
  fixture.componentInstance.renewed.subscribe(renewed);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const input = () => root.querySelector<HTMLInputElement>('input[type=date]')!;
  const button = () => root.querySelector<HTMLButtonElement>('button')!;
  const type = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    await view();
  };
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  return { fixture, root, view, input, button, type, renewed, toasts };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('PlaceRenewal', () => {
  it('shows the stored date, labelled with the name of the place', async () => {
    const { input, button, root } = await render();
    expect(input().value).toBe('2030-01-01');
    expect(root.textContent).toContain('PLACES.RENEW.ACTION');
    expect(button().getAttribute('aria-label')).toBe(LABEL);
  });

  it('starts empty when the place has no expiration date', async () => {
    const { input } = await render(fakeListItem({ expirationDate: null }));
    expect(input().value).toBe('');
  });

  it('keeps the button disabled until the date changes', async () => {
    const { button, type } = await render();
    expect(button().disabled).toBe(true);
    await type('2031-05-06');
    expect(button().disabled).toBe(false);
    await type('2030-01-01');
    expect(button().disabled).toBe(true);
  });

  it('follows the stored date when the place of the row changes', async () => {
    const { fixture, input, type, view } = await render();
    await type('2031-05-06');
    fixture.componentRef.setInput(
      'place',
      fakeListItem({ expirationDate: '2032-07-08T00:00:00.000Z' }),
    );
    await view();
    expect(input().value).toBe('2032-07-08');
  });

  it('renews with the version just read and the new date, then reports it', async () => {
    const { type, button, view, renewed, toasts, input } = await render();
    await type('2031-05-06');
    button().click();
    await view();
    expect(button().disabled).toBe(true);
    expect(input().disabled).toBe(true);
    backend()
      .expectOne(URL)
      .flush({ data: fakePlace() }, { headers: { ETag: ETAG } });
    await view();
    const put = backend().expectOne(`${URL}/license`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.headers.get('If-Match')).toBe(ETAG);
    expect(put.request.body).toMatchObject({ expirationDate: '2031-05-06' });
    put.flush({ data: fakePlace() });
    await view();
    expect(toasts()).toEqual(['success: PLACES.RENEW.DONE {"name":"Bar Roma"}']);
    expect(renewed).toHaveBeenCalledTimes(1);
    expect(input().disabled).toBe(false);
  });

  it('sends no date when the field is emptied', async () => {
    const { type, button, view, renewed } = await render();
    await type('');
    button().click();
    await view();
    backend()
      .expectOne(URL)
      .flush({ data: fakePlace() }, { headers: { ETag: ETAG } });
    await view();
    const put = backend().expectOne(`${URL}/license`);
    expect(put.request.body).toMatchObject({ expirationDate: null });
    put.flush({ data: fakePlace() });
    await view();
    expect(renewed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a place changed meanwhile', 412, errorBody('PRECONDITION_FAILED'), 'PLACES.CONFLICT'],
    ['a server error', 500, errorBody('INTERNAL_ERROR'), 'ERRORS.API.INTERNAL_ERROR'],
  ])('shows %s and emits nothing', async (_label, status, body, message) => {
    const { type, button, view, renewed, toasts, input } = await render();
    await type('2031-05-06');
    button().click();
    await view();
    backend()
      .expectOne(URL)
      .flush({ data: fakePlace() }, { headers: { ETag: ETAG } });
    await view();
    backend().expectOne(`${URL}/license`).flush(body, { status, statusText: 'x' });
    await view();
    expect(toasts()).toEqual([`error: ${message}`]);
    expect(renewed).not.toHaveBeenCalled();
    expect(input().disabled).toBe(false);
    expect(input().value).toBe('2031-05-06');
  });
});
