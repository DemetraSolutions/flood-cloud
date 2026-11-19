import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../../testing/api';
import { emulateNativeDialog } from '../../../../testing/dialog';
import { apiBaseUrlInterceptor } from '../../../core/api/api-base-url.interceptor';
import { AppConfig } from '../../../core/config/app-config';
import { GroupContext } from '../../../core/groups/group-context';
import { I18nService } from '../../../core/i18n/i18n.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { CatalogManager } from './catalog-manager';
import { CatalogsApi } from './catalogs-api';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly locked?: boolean;
  readonly kept?: boolean;
}

@Component({
  imports: [CatalogManager],
  template: `<fc-catalog-manager
    kind="PRICE_LISTS"
    segment="price-lists"
    groupId="g1"
    [columns]="columns"
    [idOf]="idOf"
    [nameOf]="nameOf"
    [canWrite]="canWrite()"
    [allowCreate]="allowCreate()"
    [allowDelete]="allowDelete()"
    [updateMethod]="updateMethod()"
    [limit]="limit()"
    [locked]="locked"
    [kept]="kept"
    [lockedNote]="lockedNote()"
    [wide]="wide()"
    [viewable]="viewable()"
  >
    <ng-template
      #editor
      let-item
      let-error="error"
      let-busy="busy"
      let-readonly="readonly"
      let-save="save"
      let-cancel="cancel"
    >
      <p class="editing">{{ item === null ? 'new' : item.name }}</p>
      <p class="failure">{{ error === null ? '' : error.code }}</p>
      <p class="busy">{{ busy }}</p>
      <p class="readonly">{{ readonly }}</p>
      <button type="button" class="do-save" (click)="save({ name: 'body' })">go</button>
      <button type="button" class="do-cancel" (click)="cancel()">stop</button>
    </ng-template>
  </fc-catalog-manager>`,
})
class Host {
  readonly canWrite = signal(true);
  readonly allowCreate = signal(true);
  readonly allowDelete = signal(true);
  readonly updateMethod = signal<'PATCH' | 'PUT'>('PATCH');
  readonly limit = signal<number | null>(null);
  readonly lockedNote = signal<string | null>(null);
  readonly wide = signal(false);
  readonly viewable = signal(false);
  readonly columns = [{ key: 'name', header: 'Name', cell: (row: Row) => row.name }];
  readonly idOf = (row: Row) => row.id;
  readonly nameOf = (row: Row) => row.name;
  readonly locked = (row: Row) => row.locked === true;
  readonly kept = (row: Row) => row.kept === true;
}

const LIST = `${API}/v1/groups/g1/price-lists`;
const ALPHA: Row = { id: 'a', name: 'Alpha' };
const BETA: Row = { id: 'b', name: 'Beta' };

async function render(options: { raw?: boolean } = {}) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: options.raw
      ? [
          provideHttpClient(withInterceptors([apiBaseUrlInterceptor])),
          provideHttpClientTesting(),
          { provide: AppConfig, useValue: { apiBaseUrl: signal(API).asReadonly() } },
        ]
      : provideApiTesting(),
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const load = async (rows: Row[] = [ALPHA, BETA]) => {
    backend().expectOne(LIST).flush({ data: rows });
    await view();
  };
  const dialogs = () => [...root.querySelectorAll<HTMLDialogElement>('dialog')];
  const press = async (element: Element | null | undefined) => {
    (element as HTMLElement).click();
    await view();
  };
  const byLabel = (prefix: string, name: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label='${prefix} {"name":"${name}"}']`);
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => [t.kind, t.message]);
  return {
    host: fixture.componentInstance,
    fixture,
    root,
    view,
    load,
    dialogs,
    press,
    byLabel,
    toasts,
    newButton: () =>
      [...root.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'CATALOG.PRICE_LISTS.NEW',
      ),
    cells: () =>
      [...root.querySelectorAll('tbody tr')].map((r) =>
        r.querySelector('th, td')?.textContent?.trim(),
      ),
    editor: () => ({
      editing: dialogs()[0].querySelector('.editing')?.textContent,
      failure: dialogs()[0].querySelector('.failure')?.textContent,
      busy: dialogs()[0].querySelector('.busy')?.textContent,
      save: dialogs()[0].querySelector('.do-save'),
      cancel: dialogs()[0].querySelector('.do-cancel'),
    }),
    confirm: () => dialogs()[1].querySelectorAll<HTMLButtonElement>('footer button'),
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('CatalogManager: reading', () => {
  it('shows a loading table, then the elements', async () => {
    const { root, load, cells } = await render();
    expect(root.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    await load([ALPHA]);
    expect(root.querySelector('table')?.getAttribute('aria-busy')).toBeNull();
    expect(cells()).toEqual(['Alpha']);
  });

  it('lists the elements with the texts of the catalog', async () => {
    const { root, load, cells } = await render();
    await load();
    expect(root.querySelector('h2')?.textContent).toBe('CATALOG.PRICE_LISTS.TITLE');
    expect(root.querySelector('p.hint')?.textContent).toBe('CATALOG.PRICE_LISTS.HINT');
    expect(cells()).toEqual(['Alpha', 'Beta']);
  });

  it('says so when there are no elements', async () => {
    const { root, load } = await render();
    await load([]);
    expect(root.querySelector('tbody')?.textContent).toContain('CATALOG.PRICE_LISTS.EMPTY');
  });

  it('shows no actions to whoever cannot write', async () => {
    const { host, root, load, view, newButton } = await render();
    host.canWrite.set(false);
    await view();
    await load();
    expect(newButton()).toBeUndefined();
    expect(root.querySelector('fc-actions-menu')).toBeNull();
    expect(root.querySelector('th.actions')).toBeNull();
  });

  it('shows the load error with its request id and loads again on retry', async () => {
    const { root, press, load, cells, view } = await render();
    backend()
      .expectOne(LIST)
      .flush(errorBody('INTERNAL_ERROR'), {
        status: 500,
        statusText: 'x',
        headers: { 'X-Request-Id': 'req-1' },
      });
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('CATALOG.LOAD_ERROR');
    expect(root.querySelector('fc-error-state')?.textContent).toContain(
      'ERRORS.API.INTERNAL_ERROR',
    );
    expect(root.querySelector('fc-error-state')?.textContent).toContain('req-1');
    expect(root.querySelector('table')).toBeNull();
    await press(
      [...root.querySelectorAll('fc-error-state button')].find(
        (b) => b.textContent?.trim() === 'COMMON.RETRY',
      ),
    );
    await load();
    expect(cells()).toEqual(['Alpha', 'Beta']);
  });

  it('shows a generic message when the failure is not from the API', async () => {
    const { root, view } = await render({ raw: true });
    backend().expectOne(LIST).flush('x', { status: 500, statusText: 'x' });
    await view();
    const state = root.querySelector('fc-error-state')!;
    expect(state.textContent).toContain('ERRORS.GENERIC.MESSAGE');
    expect(state.textContent).not.toContain('ERRORS.REQUEST_ID');
  });
});

describe('CatalogManager: limits and permissions', () => {
  it('offers "new" to writers and hides it when creation is not allowed', async () => {
    const { host, load, newButton, view } = await render();
    await load();
    expect(newButton()?.disabled).toBe(false);
    host.allowCreate.set(false);
    await view();
    expect(newButton()).toBeUndefined();
  });

  it('stops offering "new" at the limit and says why', async () => {
    const { host, root, load, newButton, view } = await render();
    host.limit.set(2);
    await view();
    await load();
    expect(newButton()?.disabled).toBe(true);
    expect(root.querySelector('p[role=status]')?.textContent).toBe(
      'CATALOG.LIMIT_REACHED {"max":2}',
    );
    host.limit.set(3);
    await view();
    expect(newButton()?.disabled).toBe(false);
    expect(root.querySelector('p[role=status]')).toBeNull();
  });

  it('gives no actions on locked rows and no deletion on kept rows or when deleting is off', async () => {
    const { host, load, byLabel, view } = await render();
    await load([
      { id: 'l', name: 'Locked', locked: true },
      { id: 'k', name: 'Kept', kept: true },
      ALPHA,
    ]);
    expect(byLabel('CATALOG.EDIT_LABEL', 'Locked')).toBeNull();
    expect(byLabel('CATALOG.DELETE_LABEL', 'Locked')).toBeNull();
    expect(byLabel('CATALOG.EDIT_LABEL', 'Kept')).not.toBeNull();
    expect(byLabel('CATALOG.DELETE_LABEL', 'Kept')).toBeNull();
    expect(byLabel('CATALOG.DELETE_LABEL', 'Alpha')).not.toBeNull();
    host.allowDelete.set(false);
    await view();
    expect(byLabel('CATALOG.EDIT_LABEL', 'Alpha')).not.toBeNull();
    expect(byLabel('CATALOG.DELETE_LABEL', 'Alpha')).toBeNull();
  });
});

describe('CatalogManager: creating and modifying', () => {
  it('opens an empty editor, creates the element and loads the table again', async () => {
    const { dialogs, press, newButton, editor, load, toasts, view } = await render();
    await load();
    await press(newButton());
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    expect(dialogs()[0].querySelector('h2')?.textContent).toBe('CATALOG.PRICE_LISTS.NEW_TITLE');
    expect(editor().editing).toBe('new');
    await press(editor().save);
    expect(editor().busy).toBe('true');
    const request = backend().expectOne(LIST);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ name: 'body' });
    request.flush({ data: ALPHA }, { status: 201, statusText: 'Created' });
    await view();
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
    expect(toasts()).toEqual([['success', 'CATALOG.CREATED']]);
    await load([ALPHA, BETA, { id: 'c', name: 'Gamma' }]);
  });

  it('modifies an element with PATCH', async () => {
    const { dialogs, press, byLabel, editor, load, toasts, view } = await render();
    await load();
    await press(byLabel('CATALOG.EDIT_LABEL', 'Beta'));
    expect(dialogs()[0].querySelector('h2')?.textContent).toBe('CATALOG.PRICE_LISTS.EDIT_TITLE');
    expect(editor().editing).toBe('Beta');
    await press(editor().save);
    const request = backend().expectOne(`${LIST}/b`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ name: 'body' });
    request.flush({ data: BETA });
    await view();
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
    expect(toasts()).toEqual([['success', 'CATALOG.SAVED']]);
    await load();
  });

  it('replaces an element with PUT when so configured', async () => {
    const { host, press, byLabel, editor, load, view } = await render();
    host.updateMethod.set('PUT');
    await view();
    await load();
    await press(byLabel('CATALOG.EDIT_LABEL', 'Alpha'));
    await press(editor().save);
    const request = backend().expectOne(`${LIST}/a`);
    expect(request.request.method).toBe('PUT');
    request.flush({ data: ALPHA });
    await view();
    await load();
  });

  it('closes the editor on cancel and when the dialog is dismissed', async () => {
    const { dialogs, press, newButton, editor, load, view } = await render();
    await load();
    await press(newButton());
    await press(editor().cancel);
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
    await press(newButton());
    dialogs()[0].close();
    await view();
    expect(dialogs()[0].hasAttribute('open')).toBe(false);
  });

  it('keeps the editor open with the rejection of the fields', async () => {
    const { dialogs, press, newButton, editor, load, view } = await render();
    await load();
    await press(newButton());
    await press(editor().save);
    backend()
      .expectOne(LIST)
      .flush(errorBody('VALIDATION_ERROR', [{ field: 'name', issue: 'taken' }]), {
        status: 422,
        statusText: 'x',
      });
    await view();
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    expect(editor().failure).toBe('VALIDATION_ERROR');
    expect(editor().busy).toBe('false');
    // The next opening starts clean and nothing is reloaded.
    await press(editor().cancel);
    await press(newButton());
    expect(editor().failure).toBe('');
  });

  it('reloads the table after a concurrent change and shows it in the editor', async () => {
    const { dialogs, press, byLabel, editor, load, view, toasts } = await render();
    await load();
    await press(byLabel('CATALOG.EDIT_LABEL', 'Alpha'));
    await press(editor().save);
    backend().expectOne(`${LIST}/a`).flush(errorBody('CONFLICT'), { status: 409, statusText: 'x' });
    await view();
    expect(dialogs()[0].hasAttribute('open')).toBe(true);
    expect(editor().failure).toBe('CONFLICT');
    expect(toasts()).toEqual([]);
    await load([{ id: 'a', name: 'Alpha 2' }]);
  });

  it('does not reload after a conflict that has details', async () => {
    const { press, byLabel, editor, load, view } = await render();
    await load();
    await press(byLabel('CATALOG.EDIT_LABEL', 'Alpha'));
    await press(editor().save);
    backend()
      .expectOne(`${LIST}/a`)
      .flush(errorBody('CONFLICT', [{ field: 'name', issue: 'taken' }]), {
        status: 409,
        statusText: 'x',
      });
    await view();
    expect(editor().failure).toBe('CONFLICT');
  });

  it('logs a failure that is not from the API and reports it as unexpected', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(CatalogsApi.prototype, 'create').mockRejectedValue(new Error('boom'));
    const { press, newButton, editor, load } = await render();
    await load();
    await press(newButton());
    await press(editor().save);
    expect(editor().failure).toBe('UNKNOWN_ERROR');
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('CatalogManager: deleting', () => {
  it('asks for confirmation, deletes, reports and loads again', async () => {
    const { dialogs, press, byLabel, confirm, load, toasts, view } = await render();
    await load();
    await press(byLabel('CATALOG.DELETE_LABEL', 'Beta'));
    expect(dialogs()[1].hasAttribute('open')).toBe(true);
    expect(dialogs()[1].querySelector('p')?.textContent).toBe(
      'CATALOG.PRICE_LISTS.DELETE_CONFIRM {"name":"Beta"}',
    );
    await press(confirm()[1]);
    const request = backend().expectOne(`${LIST}/b`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await view();
    expect(dialogs()[1].hasAttribute('open')).toBe(false);
    expect(toasts()).toEqual([['success', 'CATALOG.DELETED']]);
    await load([ALPHA]);
  });

  it('does nothing when the confirmation is cancelled or dismissed', async () => {
    const { dialogs, press, byLabel, confirm, load, view } = await render();
    await load();
    await press(byLabel('CATALOG.DELETE_LABEL', 'Beta'));
    await press(confirm()[0]);
    expect(dialogs()[1].hasAttribute('open')).toBe(false);
    await press(byLabel('CATALOG.DELETE_LABEL', 'Beta'));
    dialogs()[1].close();
    await view();
    expect(dialogs()[1].hasAttribute('open')).toBe(false);
  });

  it.each([
    ['default', 'CATALOG.ERROR.DEFAULT'],
    ['last', 'CATALOG.ERROR.LAST'],
  ])('explains a refused deletion (%s) and loads again', async (issue, message) => {
    const { press, byLabel, confirm, load, toasts, view } = await render();
    await load();
    await press(byLabel('CATALOG.DELETE_LABEL', 'Alpha'));
    await press(confirm()[1]);
    backend()
      .expectOne(`${LIST}/a`)
      .flush(errorBody('CONFLICT', [{ field: 'id', issue }]), { status: 409, statusText: 'x' });
    await view();
    expect(toasts()).toEqual([['error', message]]);
    await load();
  });

  it('names who still uses the element', async () => {
    const { press, byLabel, confirm, load, toasts, view } = await render();
    await load();
    await press(byLabel('CATALOG.DELETE_LABEL', 'Alpha'));
    await press(confirm()[1]);
    backend()
      .expectOne(`${LIST}/a`)
      .flush(
        errorBody('CONFLICT', [
          { field: 'cardTypes.x', issue: 'referenced' },
          { field: 'cardTypes.y', issue: 'referenced' },
        ]),
        { status: 409, statusText: 'x' },
      );
    await view();
    expect(toasts()[0][1]).toContain('CATALOG.ERROR.REFERENCED');
    expect(toasts()[0][1]).toContain('CATALOG.REFERENCED.CARDTYPES');
    await load();
  });

  it('reports a concurrent change', async () => {
    const { press, byLabel, confirm, load, toasts, view } = await render();
    await load();
    await press(byLabel('CATALOG.DELETE_LABEL', 'Alpha'));
    await press(confirm()[1]);
    backend().expectOne(`${LIST}/a`).flush(errorBody('CONFLICT'), { status: 409, statusText: 'x' });
    await view();
    expect(toasts()).toEqual([['error', 'CATALOG.ERROR.CONCURRENT']]);
    await load();
  });

  describe('explanation of read-only elements', () => {
    it('does not show the note when no element is read-only', async () => {
      const { host, load, root } = await render();
      host.lockedNote.set('CATALOG.CARD_TYPES.LOCKED_NOTE');
      await load([ALPHA, BETA]);
      expect(root.querySelector('[role=note]')).toBeNull();
    });

    it('shows the note when an element is locked, and not without a note text', async () => {
      const { host, load, root, view } = await render();
      host.lockedNote.set('CATALOG.CARD_TYPES.LOCKED_NOTE');
      await load([ALPHA, { id: 'c', name: 'Gamma', locked: true }]);
      expect(root.querySelector('[role=note]')?.textContent?.trim()).toBe(
        'CATALOG.CARD_TYPES.LOCKED_NOTE',
      );
      host.lockedNote.set(null);
      await view();
      expect(root.querySelector('[role=note]')).toBeNull();
    });
  });

  describe('wide dialog', () => {
    it('makes the editor dialog wide on request', async () => {
      const { host, load, dialogs, view } = await render();
      await load();
      expect(dialogs()[0].classList.contains('wide')).toBe(false);
      host.wide.set(true);
      await view();
      expect(dialogs()[0].classList.contains('wide')).toBe(true);
    });
  });

  describe('working group', () => {
    it('leaves the working group alone', async () => {
      const choose = vi.spyOn(GroupContext.prototype, 'choose');
      const { load } = await render();
      await load();
      expect(choose).not.toHaveBeenCalled();
    });
  });

  describe('viewing read-only elements', () => {
    const LOCKED: Row = { id: 'c', name: 'Gamma', locked: true };

    it('offers only "View" on a locked element when asked, and opens it for reading', async () => {
      const { host, load, byLabel, press, dialogs, view, root } = await render();
      host.viewable.set(true);
      host.lockedNote.set('CATALOG.CARD_TYPES.LOCKED_NOTE');
      await load([ALPHA, LOCKED]);
      expect(byLabel('CATALOG.EDIT_LABEL', 'Gamma')).toBeNull();
      expect(byLabel('CATALOG.DELETE_LABEL', 'Gamma')).toBeNull();
      expect(byLabel('CATALOG.VIEW_LABEL', 'Alpha')).toBeNull();
      await press(byLabel('CATALOG.VIEW_LABEL', 'Gamma'));
      const dialog = dialogs()[0];
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(dialog.querySelector('h2')?.textContent).toBe('CATALOG.VIEW_TITLE');
      expect(dialog.querySelector('.editing')?.textContent).toBe('Gamma');
      expect(dialog.querySelector('.readonly')?.textContent).toBe('true');
      expect(dialog.querySelector('[role=note]')?.textContent?.trim()).toBe(
        'CATALOG.CARD_TYPES.LOCKED_NOTE',
      );
      await view();
      root.querySelector<HTMLButtonElement>('.do-cancel')!.click();
    });

    it('opens an editable element normally, not for reading', async () => {
      const { host, load, byLabel, press, dialogs } = await render();
      host.viewable.set(true);
      await load([ALPHA, LOCKED]);
      await press(byLabel('CATALOG.EDIT_LABEL', 'Alpha'));
      expect(dialogs()[0].querySelector('.readonly')?.textContent).toBe('false');
      expect(dialogs()[0].querySelector('[role=note]')).toBeNull();
    });

    it('shows the actions to those who cannot write only when elements are viewable', async () => {
      const { host, load, byLabel, view } = await render();
      host.canWrite.set(false);
      await load([LOCKED]);
      expect(byLabel('CATALOG.VIEW_LABEL', 'Gamma')).toBeNull();
      host.viewable.set(true);
      await view();
      expect(byLabel('CATALOG.VIEW_LABEL', 'Gamma')).not.toBeNull();
    });
  });
});
