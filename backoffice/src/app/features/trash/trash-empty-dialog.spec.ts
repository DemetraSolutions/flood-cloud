import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { GROUP, result } from '../../../testing/trash';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { TrashEmptyDialog } from './trash-empty-dialog';
import { TrashItemResult } from './trash.types';

const EMPTY = `${API}/v1/groups/${GROUP}/trash/companies/empty`;

function render(count: number | null = 3) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: [provideApiTesting()] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(TrashEmptyDialog);
  fixture.componentRef.setInput('groupId', GROUP);
  fixture.componentRef.setInput('kind', 'companies');
  fixture.componentRef.setInput('count', count);
  const root = fixture.nativeElement as HTMLElement;
  const finished: (readonly TrashItemResult[])[] = [];
  const bodies: unknown[] = [];
  fixture.componentInstance.finished.subscribe((results) => finished.push(results));
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const open = async () => {
    fixture.componentRef.setInput('open', true);
    await view();
  };
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const tickUnderstood = async () => {
    const box = root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await view();
  };
  const answer = async (
    results: TrashItemResult[],
    remaining: number,
    next: string | null = null,
  ) => {
    const req = backend().expectOne(EMPTY);
    bodies.push(req.request.body);
    req.flush({ data: { results, remaining, next } });
    await view();
  };
  const toasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => `${t.kind}: ${t.message}`);
  return { fixture, root, finished, bodies, view, open, button, tickUnderstood, answer, toasts };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
});

describe('TrashEmptyDialog', () => {
  it('states the count and the kind, and needs the confirmation to be ticked', async () => {
    const { root, open, button, tickUnderstood } = render(3);
    await open();
    expect(root.querySelector('dialog h2')?.textContent).toBe(
      'TRASH.EMPTY.TITLE {"kind":"TRASH.KIND.COMPANIES"}',
    );
    expect(root.querySelector('dialog p')?.textContent).toBe(
      'TRASH.EMPTY.MESSAGE_COUNT {"count":3,"kind":"TRASH.KIND.COMPANIES"}',
    );
    expect(button('TRASH.EMPTY.START').disabled).toBe(true);
    await tickUnderstood();
    expect(button('TRASH.EMPTY.START').disabled).toBe(false);
  });

  it('says all the pages are emptied when the count is not known', async () => {
    const { root, open } = render(null);
    await open();
    expect(root.querySelector('dialog p')?.textContent).toBe(
      'TRASH.EMPTY.MESSAGE_ALL {"kind":"TRASH.KIND.COMPANIES"}',
    );
  });

  it('calls empty again with the cursor, shows the progress, and ends when there is no next', async () => {
    const { root, finished, bodies, open, button, tickUnderstood, answer, fixture } = render();
    await open();
    await tickUnderstood();
    button('TRASH.EMPTY.START').click();
    await settle();
    fixture.detectChanges();
    expect(root.querySelector('[role=status]')?.textContent).toBe('TRASH.EMPTY.STARTING');
    await answer([result('a', 'deleted'), result('b', 'deleted')], 1, 'b');
    expect(root.querySelector('[role=status]')?.textContent).toBe(
      'TRASH.EMPTY.PROGRESS {"deleted":2,"remaining":1}',
    );
    await answer([result('c', 'deleted')], 0);
    expect(bodies).toEqual([null, { after: 'b' }]);
    expect(finished).toEqual([
      [result('a', 'deleted'), result('b', 'deleted'), result('c', 'deleted')],
    ]);
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('goes on past items that cannot be deleted, following the cursor', async () => {
    const { finished, bodies, open, button, tickUnderstood, answer } = render();
    await open();
    await tickUnderstood();
    button('TRASH.EMPTY.START').click();
    await settle();
    await answer([result('a', 'skipped', 'referenced')], 1, 'a');
    await answer([result('b', 'deleted')], 0);
    expect(bodies).toEqual([null, { after: 'a' }]);
    expect(finished).toEqual([[result('a', 'skipped', 'referenced'), result('b', 'deleted')]]);
  });

  it('can be stopped between two calls', async () => {
    const { root, finished, open, button, tickUnderstood, answer, view } = render();
    await open();
    await tickUnderstood();
    button('TRASH.EMPTY.START').click();
    await settle();
    root.querySelector<HTMLButtonElement>('dialog footer button')!.click();
    await view();
    expect(root.textContent).toContain('TRASH.EMPTY.STOPPING');
    expect(button('TRASH.EMPTY.STOP').disabled).toBe(true);
    await answer([result('a', 'deleted')], 5, 'a');
    expect(finished).toEqual([[result('a', 'deleted')]]);
  });

  it('closing the dialog while it runs stops it too', async () => {
    const { root, finished, open, button, tickUnderstood, answer, view } = render();
    await open();
    await tickUnderstood();
    button('TRASH.EMPTY.START').click();
    await settle();
    root.querySelector('dialog')!.dispatchEvent(new Event('close'));
    await view();
    await answer([result('a', 'deleted')], 5, 'a');
    expect(finished).toHaveLength(1);
  });

  it('closing the dialog when it is not running does nothing more', async () => {
    const { root, finished, open, view, fixture } = render();
    await open();
    root.querySelector<HTMLButtonElement>('dialog header button')!.click();
    await view();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(finished).toEqual([]);
  });

  it('cancels from the confirmation without calling the server', async () => {
    const { open, button, view, fixture, finished } = render();
    await open();
    button('COMMON.CANCEL').click();
    await view();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(finished).toEqual([]);
  });

  it('reports a failure and ends with what was done before it', async () => {
    const { finished, open, button, tickUnderstood, answer, view, toasts } = render();
    await open();
    await tickUnderstood();
    button('TRASH.EMPTY.START').click();
    await settle();
    await answer([result('a', 'deleted')], 2, 'a');
    backend()
      .expectOne(EMPTY)
      .flush(errorBody('RATE_LIMITED'), { status: 429, statusText: 'RATE_LIMITED' });
    await view();
    expect(toasts()).toEqual(['error: ERRORS.API.RATE_LIMITED']);
    expect(finished).toEqual([[result('a', 'deleted')]]);
  });

  it('starts again from the confirmation when it is opened again', async () => {
    const { fixture, open, button, tickUnderstood, answer, view } = render();
    await open();
    await tickUnderstood();
    button('TRASH.EMPTY.START').click();
    await settle();
    await answer([result('a', 'deleted')], 0);
    fixture.componentRef.setInput('open', false);
    await view();
    await open();
    expect(button('TRASH.EMPTY.START').disabled).toBe(true);
  });
});
