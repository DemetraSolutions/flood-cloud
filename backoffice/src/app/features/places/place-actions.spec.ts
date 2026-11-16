import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { ETAG, GROUP, PLACE, PLACE_2, fakeListItem, fakePlace } from '../../../testing/places';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PlaceAction, PlaceActions } from './place-actions';

const ITEM = fakeListItem({ name: 'Bar Roma' });
const OTHER = fakeListItem({ id: PLACE_2, name: 'Bar Milano' });
const COPY = '665f1c2e9b1d4a0012ab34c9';
const URL = `${API}/v1/groups/${GROUP}/places/${PLACE}`;

async function render() {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: [provideApiTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(PlaceActions);
  fixture.componentRef.setInput('groupId', GROUP);
  const done = vi.fn();
  fixture.componentInstance.done.subscribe(done);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const run = async (action: PlaceAction, item = ITEM) => {
    fixture.componentInstance.run(action, item);
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  /** Answers the read of the version that precedes every action but the duplication. */
  const version = async () => {
    backend()
      .expectOne(URL)
      .flush({ data: fakePlace() }, { headers: { ETag: ETAG } });
    await view();
  };
  /** Confirms the open dialog and answers the duplication; returns the request. */
  const confirmDuplicate = async () => {
    button('PLACES.ACTION.LABEL.DUPLICATE').click();
    await view();
    return backend().expectOne(`${URL}/duplicate`);
  };
  return { fixture, root, view, run, button, done, toasts, version, confirmDuplicate };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('PlaceActions', () => {
  it('asks for confirmation naming the place before trashing, then presents the version', async () => {
    const { run, root, button, version, view, done, toasts } = await render();
    await run('trash');
    expect(root.querySelector('dialog')?.textContent).toContain(
      'PLACES.ACTION.CONFIRM.TRASH {"name":"Bar Roma"}',
    );
    expect(root.querySelector('dialog')?.textContent).toContain('PLACES.ACTION.TITLE.TRASH');
    expect(button('PLACES.ACTION.LABEL.TRASH').getAttribute('data-variant')).toBe('danger');
    button('PLACES.ACTION.LABEL.TRASH').click();
    await view();
    await version();
    const req = backend().expectOne(`${URL}/trash`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    expect(req.request.headers.has('Idempotency-Key')).toBe(false);
    req.flush({ data: fakePlace({ trashed: true }) });
    await view();
    expect(toasts()).toEqual(['success: PLACES.ACTION.DONE.TRASH {"name":"Bar Roma"}']);
    expect(done).toHaveBeenCalledWith({ action: 'trash', copyId: null });
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  it('does not act when the user cancels', async () => {
    const { run, button, view, done } = await render();
    await run('delete');
    button('COMMON.CANCEL').click();
    await view();
    expect(done).not.toHaveBeenCalled();
  });

  it('restores without asking', async () => {
    const { run, root, version, done, toasts, view } = await render();
    await run('restore');
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    await version();
    const req = backend().expectOne(`${URL}/restore`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    req.flush({ data: fakePlace() });
    await view();
    expect(toasts()).toEqual(['success: PLACES.ACTION.DONE.RESTORE {"name":"Bar Roma"}']);
    expect(done).toHaveBeenCalledWith({ action: 'restore', copyId: null });
  });

  it('deletes for good after confirmation', async () => {
    const { run, button, view, version, done, toasts } = await render();
    await run('delete');
    button('PLACES.ACTION.LABEL.DELETE').click();
    await view();
    await version();
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    req.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    expect(toasts()).toEqual(['success: PLACES.ACTION.DONE.DELETE {"name":"Bar Roma"}']);
    expect(done).toHaveBeenCalledWith({ action: 'delete', copyId: null });
  });

  it('duplicates after a non-danger confirmation, with an idempotency key and no version', async () => {
    const { run, root, button, confirmDuplicate, view, done, toasts } = await render();
    await run('duplicate');
    expect(root.querySelector('dialog')?.textContent).toContain(
      'PLACES.ACTION.CONFIRM.DUPLICATE {"name":"Bar Roma"}',
    );
    expect(button('PLACES.ACTION.LABEL.DUPLICATE').getAttribute('data-variant')).toBe('primary');
    const req = await confirmDuplicate();
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toBeNull();
    expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.request.headers.has('If-Match')).toBe(false);
    req.flush({ data: fakePlace({ id: COPY }) }, { status: 201, statusText: 'Created' });
    await view();
    expect(toasts()).toEqual(['success: PLACES.ACTION.DONE.DUPLICATE {"name":"Bar Roma"}']);
    expect(done).toHaveBeenCalledWith({ action: 'duplicate', copyId: COPY });
  });

  it('reuses the key when the duplication of the same place is retried after a failure', async () => {
    const { run, confirmDuplicate, view, done, toasts } = await render();
    await run('duplicate');
    const first = await confirmDuplicate();
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(toasts()).toEqual(['error: ERRORS.API.INTERNAL_ERROR']);
    expect(done).not.toHaveBeenCalled();
    await run('duplicate');
    const second = await confirmDuplicate();
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    second.flush({ data: fakePlace({ id: COPY }) }, { status: 201, statusText: 'Created' });
    await view();
    expect(done).toHaveBeenCalledWith({ action: 'duplicate', copyId: COPY });
  });

  it('uses a new key after a success, and another one for another place', async () => {
    const { run, button, confirmDuplicate, view } = await render();
    await run('duplicate');
    const first = await confirmDuplicate();
    first.flush({ data: fakePlace({ id: COPY }) }, { status: 201, statusText: 'Created' });
    await view();
    await run('duplicate');
    const second = await confirmDuplicate();
    expect(second.request.headers.get('Idempotency-Key')).not.toBe(
      first.request.headers.get('Idempotency-Key'),
    );
    second.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    await run('duplicate', OTHER);
    button('PLACES.ACTION.LABEL.DUPLICATE').click();
    await view();
    const third = backend().expectOne(`${API}/v1/groups/${GROUP}/places/${PLACE_2}/duplicate`);
    expect(third.request.headers.get('Idempotency-Key')).not.toBe(
      second.request.headers.get('Idempotency-Key'),
    );
    third.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
  });

  it.each([
    [
      'a place that was changed meanwhile',
      412,
      errorBody('PRECONDITION_FAILED'),
      'PLACES.CONFLICT',
    ],
    [
      'a place still referenced',
      409,
      errorBody('CONFLICT', [{ field: 'places', issue: 'referenced' }]),
      'PLACES.ACTION.ERROR_REFERENCED',
    ],
    [
      'a company that is gone',
      409,
      errorBody('CONFLICT', [{ field: 'companyId', issue: 'not_found' }]),
      'PLACES.ACTION.ERROR_COMPANY',
    ],
    [
      'a place in the wrong state',
      409,
      errorBody('CONFLICT', [{ field: 'trashed', issue: 'invalid_state' }]),
      'PLACES.ACTION.ERROR_STATE',
    ],
    ['a conflict without details', 409, errorBody('CONFLICT'), 'PLACES.ACTION.ERROR_STATE'],
    ['a permission the user lost', 403, errorBody('FORBIDDEN'), 'ERRORS.API.FORBIDDEN'],
  ])('shows %s', async (_label, status, body, message) => {
    const { run, button, view, version, done, toasts } = await render();
    await run('delete');
    button('PLACES.ACTION.LABEL.DELETE').click();
    await view();
    await version();
    backend().expectOne(URL).flush(body, { status, statusText: 'x' });
    await view();
    expect(toasts()).toEqual([`error: ${message}`]);
    expect(done).not.toHaveBeenCalled();
  });

  it('shows the failure of the read of the version', async () => {
    const { run, view, done, toasts } = await render();
    await run('restore');
    backend().expectOne(URL).flush(errorBody('NOT_FOUND'), { status: 404, statusText: 'x' });
    await view();
    expect(toasts()).toEqual(['error: ERRORS.API.NOT_FOUND']);
    expect(done).not.toHaveBeenCalled();
  });
});
