import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { COMPANY, ETAG, GROUP, fakeCompany } from '../../../testing/companies';
import { emulateNativeDialog } from '../../../testing/dialog';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { CompanyAction, CompanyActions } from './company-actions';
import { CompanyListItem } from './company.types';

const ITEM: CompanyListItem = {
  id: COMPANY,
  name: 'Azienda Esempio Srl',
  vatNumber: '01114601006',
  city: 'Milano',
  province: 'MI',
  country: 'IT',
  status: 'active',
  trashed: false,
};
const URL = `${API}/v1/groups/${GROUP}/companies/${COMPANY}`;

async function render() {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: [provideApiTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(CompanyActions);
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
  const run = async (action: CompanyAction) => {
    fixture.componentInstance.run(action, ITEM);
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
  /** Answers the read of the version that precedes every action. */
  const version = async () => {
    backend()
      .expectOne(URL)
      .flush({ data: fakeCompany() }, { headers: { ETag: ETAG } });
    await view();
  };
  return { fixture, root, view, run, button, done, toasts, version };
}

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CompanyActions', () => {
  it('asks for confirmation naming the company before trashing, then presents the version', async () => {
    const { run, root, button, version, view, done, toasts } = await render();
    await run('trash');
    expect(root.querySelector('dialog')?.textContent).toContain(
      'COMPANIES.ACTION.CONFIRM.TRASH {"name":"Azienda Esempio Srl"}',
    );
    button('COMPANIES.ACTION.LABEL.TRASH').click();
    await view();
    await version();
    const req = backend().expectOne(`${URL}/trash`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    req.flush({ data: fakeCompany({ trashed: true }) });
    await view();
    expect(toasts()).toEqual([
      'success: COMPANIES.ACTION.DONE.TRASH {"name":"Azienda Esempio Srl"}',
    ]);
    expect(done).toHaveBeenCalledWith('trash');
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
    const { run, version, done, toasts, view } = await render();
    await run('restore');
    await version();
    const req = backend().expectOne(`${URL}/restore`);
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    req.flush({ data: fakeCompany() });
    await view();
    expect(toasts()).toEqual([
      'success: COMPANIES.ACTION.DONE.RESTORE {"name":"Azienda Esempio Srl"}',
    ]);
    expect(done).toHaveBeenCalledWith('restore');
  });

  it('deletes for good after confirmation', async () => {
    const { run, button, view, version, done, toasts } = await render();
    await run('delete');
    button('COMPANIES.ACTION.LABEL.DELETE').click();
    await view();
    await version();
    const req = backend().expectOne(URL);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.headers.get('If-Match')).toBe(ETAG);
    req.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    expect(toasts()).toEqual([
      'success: COMPANIES.ACTION.DONE.DELETE {"name":"Azienda Esempio Srl"}',
    ]);
    expect(done).toHaveBeenCalledWith('delete');
  });

  it.each([
    [
      'a company that was changed meanwhile',
      412,
      errorBody('PRECONDITION_FAILED'),
      'COMPANIES.CONFLICT',
    ],
    [
      'a VAT number taken meanwhile',
      409,
      errorBody('CONFLICT', [{ field: 'vatNumber', issue: 'taken' }]),
      'COMPANIES.ACTION.ERROR_VAT_TAKEN',
    ],
    [
      'stores that still point at the company',
      409,
      errorBody('CONFLICT', [{ field: 'places', issue: 'referenced' }]),
      'COMPANIES.ACTION.ERROR_REFERENCED',
    ],
    ['a permission the user lost', 403, errorBody('FORBIDDEN'), 'ERRORS.API.FORBIDDEN'],
  ])('shows %s', async (_label, status, body, message) => {
    const { run, button, view, version, done, toasts } = await render();
    await run('delete');
    button('COMPANIES.ACTION.LABEL.DELETE').click();
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
