import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { GroupActions } from './group-actions';
import { GroupStateAction } from './groups-api';

@Component({
  imports: [GroupActions],
  template: `<fc-group-actions (done)="done.update((list) => [...list, $event])" />`,
})
class Host {
  readonly actions = viewChild.required(GroupActions);
  readonly done = signal<GroupStateAction[]>([]);
}

const GROUP = { id: '665f1c2e9b1d4a0012ab34a1', name: 'Gruppo Esempio' };
const URL = `${API}/v1/groups/${GROUP.id}`;

async function render() {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const dialog = () => root.querySelector<HTMLDialogElement>('dialog')!;
  const buttons = () => dialog().querySelectorAll<HTMLButtonElement>('footer button');
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const run = async (action: GroupStateAction) => {
    fixture.componentInstance.actions().run(action, GROUP);
    await view();
  };
  const confirm = async () => {
    buttons()[1].click();
    await settle();
  };
  return {
    host: fixture.componentInstance,
    toast: TestBed.inject(ToastService),
    dialog,
    buttons,
    view,
    run,
    confirm,
  };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('GroupActions', () => {
  it.each([
    ['suspend', 'POST', '/suspension', true],
    ['reactivate', 'DELETE', '/suspension', false],
    ['trash', 'POST', '/trash', true],
    ['restore', 'POST', '/restore', false],
  ] as const)(
    '%s asks to confirm, calls the API and reports',
    async (action, method, path, danger) => {
      const { host, toast, dialog, buttons, run, confirm, view } = await render();
      await run(action);
      expect(dialog().hasAttribute('open')).toBe(true);
      expect(dialog().textContent).toContain(`GROUP_ACTIONS.CONFIRM.${action.toUpperCase()}`);
      expect(dialog().textContent).toContain(GROUP.name);
      expect(buttons()[1].textContent).toContain(`GROUP_ACTIONS.LABEL.${action.toUpperCase()}`);
      expect(buttons()[1].dataset['variant']).toBe(danger ? 'danger' : 'primary');
      await confirm();
      const request = backend().expectOne(`${URL}${path}`);
      expect(request.request.method).toBe(method);
      request.flush(null, { status: 204, statusText: 'No Content' });
      await view();
      expect(dialog().hasAttribute('open')).toBe(false);
      expect(toast.toasts().map((t) => [t.kind, t.message])).toEqual([
        ['success', `GROUP_ACTIONS.DONE.${action.toUpperCase()}`],
      ]);
      expect(host.done()).toEqual([action]);
    },
  );

  it('does nothing when the confirmation is cancelled', async () => {
    const { host, dialog, buttons, run, view } = await render();
    await run('trash');
    buttons()[0].click();
    await view();
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(host.done()).toEqual([]);
  });

  it('reports a conflict as information and still reloads the page', async () => {
    const { host, toast, dialog, run, confirm, view } = await render();
    await run('suspend');
    await confirm();
    backend()
      .expectOne(`${URL}/suspension`)
      .flush(errorBody('CONFLICT'), { status: 409, statusText: 'x' });
    await view();
    expect(toast.toasts().map((t) => [t.kind, t.message])).toEqual([
      ['info', 'GROUP_ACTIONS.ALREADY.SUSPEND'],
    ]);
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(host.done()).toEqual(['suspend']);
  });

  it.each([
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
  ] as const)('shows a %s in a toast and does not reload', async (code, status) => {
    const { host, toast, dialog, run, confirm, view } = await render();
    await run('trash');
    await confirm();
    backend().expectOne(`${URL}/trash`).flush(errorBody(code), { status, statusText: 'x' });
    await view();
    expect(toast.toasts().map((t) => t.kind)).toEqual(['error']);
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(host.done()).toEqual([]);
  });

  it('reports a network failure', async () => {
    const { host, toast, run, confirm, view } = await render();
    await run('restore');
    await confirm();
    backend().expectOne(`${URL}/restore`).error(new ProgressEvent('error'));
    await view();
    expect(toast.toasts().map((t) => t.kind)).toEqual(['error']);
    expect(host.done()).toEqual([]);
  });
});
