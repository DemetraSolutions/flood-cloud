import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { emulateNativeDialog } from '../../../testing/dialog';
import { I18nService } from '../../core/i18n/i18n.service';
import { TobaccoSyncDialog } from './tobacco-sync-dialog';
import { SyncOutcome, SyncStatus } from './tobacco-sync.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const URL = `${API}/v1/groups/${GROUP}/tobacco-sync`;
const STATUS: SyncStatus = {
  available: true,
  reasons: [],
  warehouseAllowed: true,
  tobaccoPlaces: [
    { id: 'pa', name: 'Bar Alfa' },
    { id: 'pb', name: 'Bar Beta' },
    { id: 'pc', name: 'Bar Gamma' },
  ],
  list: { entries: 10, importedAt: '2026-11-24T08:00:00.000Z' },
  lastSync: null,
};
const outcome = (dryRun: boolean, changes = 3): SyncOutcome => ({
  dryRun,
  products: {
    inserted: changes,
    updated: changes,
    disabled: changes,
    reactivated: changes,
    unchanged: 5,
    skipped: 0,
  },
  categories: { inserted: 1, duplicateNames: 0 },
  duplicateCodes: 0,
});

function render(status: SyncStatus = STATUS) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(TobaccoSyncDialog);
  fixture.componentRef.setInput('groupId', GROUP);
  fixture.componentRef.setInput('status', status);
  fixture.componentRef.setInput('open', true);
  const synced: SyncOutcome[] = [];
  fixture.componentInstance.synced.subscribe((value) => synced.push(value));
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    );
  const box = (label: string) =>
    [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (input) => input.labels?.[0]?.textContent?.trim() === label,
    )!;
  const toggle = async (label: string) => {
    const input = box(label);
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
    await view();
  };
  const check = async (dryRun = true, answer: SyncOutcome = outcome(true)) => {
    button('TOBACCO_SYNC.DIALOG.VERIFY')!.click();
    await view();
    const request = backend().expectOne(
      (r) => r.url === URL && r.method === 'POST' && r.params.has('dryRun') === dryRun,
    );
    request.flush({ data: answer });
    await view();
    return request.request;
  };
  const text = () => root.textContent ?? '';
  return { fixture, root, view, button, box, toggle, check, synced, text };
}

describe('TobaccoSyncDialog', () => {
  afterEach(() => backend().verify());

  it('opens with the defaults: warehouse and not discountable on, no point of sale chosen', async () => {
    const { view, box, text, button } = render();
    await view();
    expect(box('TOBACCO_SYNC.DIALOG.WAREHOUSE').checked).toBe(true);
    expect(box('TOBACCO_SYNC.DIALOG.NO_DISCOUNT').checked).toBe(true);
    expect(['Bar Alfa', 'Bar Beta', 'Bar Gamma'].map((name) => box(name).checked)).toEqual([
      false,
      false,
      false,
    ]);
    expect(text()).toContain('TOBACCO_SYNC.DIALOG.PLACES_HELP');
    expect(text()).toContain('TOBACCO_SYNC.DIALOG.OVERWRITE');
    expect(button('TOBACCO_SYNC.DIALOG.SYNC')).toBeUndefined();
  });

  it('checks the options with dryRun and shows what would be done', async () => {
    const { view, check, text, button } = render();
    await view();
    const request = await check();
    expect(request.body).toEqual({ warehouse: true, noDiscount: true, placeIds: [] });
    expect(text()).toContain('TOBACCO_SYNC.DIALOG.VERIFIED_TEXT');
    expect(button('TOBACCO_SYNC.DIALOG.SYNC')).toBeDefined();
  });

  it('announces the check while it runs', async () => {
    const { view, button, root } = render();
    await view();
    button('TOBACCO_SYNC.DIALOG.VERIFY')!.click();
    await view();
    expect(root.querySelector('[role="status"]')?.textContent).toBe(
      'TOBACCO_SYNC.DIALOG.VERIFYING',
    );
    backend()
      .expectOne((r) => r.url === URL)
      .flush({ data: outcome(true) });
    await view();
    expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
  });

  it('sends the chosen points of sale in the order of the list and the options as set', async () => {
    const { view, toggle, check } = render();
    await view();
    await toggle('Bar Gamma');
    await toggle('Bar Alfa');
    await toggle('TOBACCO_SYNC.DIALOG.WAREHOUSE');
    await toggle('TOBACCO_SYNC.DIALOG.NO_DISCOUNT');
    const request = await check();
    expect(request.body).toEqual({ warehouse: false, noDiscount: false, placeIds: ['pa', 'pc'] });
  });

  it('lets a point of sale be taken off again', async () => {
    const { view, toggle, check } = render();
    await view();
    await toggle('Bar Beta');
    await toggle('Bar Beta');
    expect((await check()).body.placeIds).toEqual([]);
  });

  it('does not offer the warehouse to a group that cannot move it, and never sends it', async () => {
    const { view, box, check } = render({ ...STATUS, warehouseAllowed: false });
    await view();
    expect(box('TOBACCO_SYNC.DIALOG.WAREHOUSE')).toBeUndefined();
    expect((await check()).body.warehouse).toBe(false);
  });

  it('forgets the check when an option changes', async () => {
    const { view, check, toggle, button } = render();
    await view();
    await check();
    await toggle('Bar Alfa');
    expect(button('TOBACCO_SYNC.DIALOG.SYNC')).toBeUndefined();
    expect(button('TOBACCO_SYNC.DIALOG.VERIFY')).toBeDefined();
  });

  it('says there is nothing to change and does not offer the synchronization', async () => {
    const { view, check, text, button } = render();
    await view();
    await check(true, outcome(true, 0));
    expect(text()).toContain('TOBACCO_SYNC.DIALOG.NO_CHANGES');
    expect(button('TOBACCO_SYNC.DIALOG.SYNC')).toBeUndefined();
  });

  it('shows why a check was refused', async () => {
    const { view, button, root } = render();
    await view();
    button('TOBACCO_SYNC.DIALOG.VERIFY')!.click();
    await view();
    backend()
      .expectOne((r) => r.url === URL)
      .flush(errorBody('CONFLICT', [{ field: 'group', issue: 'noZeroTaxRate' }]), {
        status: 409,
        statusText: 'Conflict',
      });
    await view();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      'TOBACCO_SYNC.ERROR.CONFLICT.noZeroTaxRate',
    );
    expect(button('TOBACCO_SYNC.DIALOG.SYNC')).toBeUndefined();
  });

  it('asks for a confirmation that repeats the effect, then synchronizes and closes', async () => {
    const { view, check, button, root, synced, fixture, toggle } = render();
    await view();
    await toggle('Bar Beta');
    await check();
    button('TOBACCO_SYNC.DIALOG.SYNC')!.click();
    await view();
    const confirm = root.querySelector('fc-confirm-dialog dialog')!;
    expect(confirm.hasAttribute('open')).toBe(true);
    expect(confirm.getAttribute('role')).toBe('alertdialog');
    expect(confirm.textContent).toContain(
      'TOBACCO_SYNC.DIALOG.CONFIRM {"inserted":3,"updated":3,"disabled":3,"reactivated":3,"places":"TOBACCO_SYNC.DIALOG.SOME_PLACES {\\"count\\":1}"}',
    );
    [...confirm.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'TOBACCO_SYNC.DIALOG.CONFIRM_ACTION')!
      .click();
    await view();
    const request = backend().expectOne((r) => r.url === URL && !r.params.has('dryRun'));
    expect(request.request.body).toEqual({ warehouse: true, noDiscount: true, placeIds: ['pb'] });
    expect(root.querySelector('[role="status"]')?.textContent).toBe('TOBACCO_SYNC.DIALOG.SYNCING');
    request.flush({ data: outcome(false) });
    await view();
    expect(synced).toEqual([outcome(false)]);
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('asks for a reinforced confirmation when the check reports a mass deactivation, and sends the confirmation', async () => {
    const { view, check, button, root, synced } = render();
    await view();
    await check(true, {
      ...outcome(true),
      massDisable: { active: 100, exceeded: true },
      products: { ...outcome(true).products, disabled: 30 },
    });
    expect(root.querySelector('.verified [role="alert"]')?.textContent).toContain(
      'TOBACCO_SYNC.DIALOG.MASS_DISABLE {"disable":30,"active":100}',
    );
    button('TOBACCO_SYNC.DIALOG.SYNC')!.click();
    await view();
    const confirm = root.querySelector('fc-confirm-dialog dialog')!;
    expect(confirm.textContent).toContain('TOBACCO_SYNC.DIALOG.CONFIRM_MASS_TITLE');
    expect(confirm.textContent).toContain(
      'TOBACCO_SYNC.DIALOG.MASS_DISABLE {"disable":30,"active":100} TOBACCO_SYNC.DIALOG.CONFIRM',
    );
    [...confirm.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'TOBACCO_SYNC.DIALOG.CONFIRM_MASS_ACTION')!
      .click();
    await view();
    const request = backend().expectOne((r) => r.url === URL && !r.params.has('dryRun'));
    expect(request.request.body.confirmMassDisable).toBe(true);
    request.flush({ data: outcome(false) });
    await view();
    expect(synced.length).toBe(1);
  });

  it('does not send the confirmation when the check reports no mass deactivation', async () => {
    const { view, check, button, root } = render();
    await view();
    await check(true, { ...outcome(true), massDisable: { active: 100, exceeded: false } });
    button('TOBACCO_SYNC.DIALOG.SYNC')!.click();
    await view();
    root
      .querySelectorAll<HTMLButtonElement>('fc-confirm-dialog button')
      .forEach((b) =>
        b.textContent?.trim() === 'TOBACCO_SYNC.DIALOG.CONFIRM_ACTION' ? b.click() : undefined,
      );
    await view();
    const request = backend().expectOne((r) => r.url === URL && !r.params.has('dryRun'));
    expect('confirmMassDisable' in request.request.body).toBe(false);
    request.flush({ data: outcome(false) });
    await view();
  });

  it('names every place when none is chosen', async () => {
    const { view, check, button, root } = render();
    await view();
    await check();
    button('TOBACCO_SYNC.DIALOG.SYNC')!.click();
    await view();
    expect(root.querySelector('fc-confirm-dialog dialog')!.textContent).toContain(
      'TOBACCO_SYNC.DIALOG.ALL_PLACES',
    );
  });

  it('keeps the check and the key after a failure that can be retried', async () => {
    const { view, check, button, root, synced } = render();
    await view();
    await check();
    const send = async () => {
      button('TOBACCO_SYNC.DIALOG.SYNC')!.click();
      await view();
      [...root.querySelectorAll<HTMLButtonElement>('fc-confirm-dialog button')]
        .find((b) => b.textContent?.trim() === 'TOBACCO_SYNC.DIALOG.CONFIRM_ACTION')!
        .dispatchEvent(new Event('click'));
      await view();
      return backend().expectOne((r) => r.url === URL && !r.params.has('dryRun'));
    };
    const first = await send();
    first.flush(errorBody('RATE_LIMITED'), { status: 429, statusText: 'Too Many Requests' });
    await view();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      'TOBACCO_SYNC.ERROR.RATE_LIMITED',
    );
    expect(button('TOBACCO_SYNC.DIALOG.SYNC')).toBeDefined();
    const second = await send();
    expect(second.request.headers.get('Idempotency-Key')).toBe(
      first.request.headers.get('Idempotency-Key'),
    );
    second.flush({ data: outcome(false) });
    await view();
    expect(synced.length).toBe(1);
  });

  it('asks for a new check after a refusal', async () => {
    const { view, check, button, root } = render();
    await view();
    await check();
    button('TOBACCO_SYNC.DIALOG.SYNC')!.click();
    await view();
    [...root.querySelectorAll<HTMLButtonElement>('fc-confirm-dialog button')]
      .find((b) => b.textContent?.trim() === 'TOBACCO_SYNC.DIALOG.CONFIRM_ACTION')!
      .click();
    await view();
    backend()
      .expectOne((r) => r.url === URL && !r.params.has('dryRun'))
      .flush(errorBody('VALIDATION_ERROR', [{ field: 'placeIds.0', issue: 'notFound' }]), {
        status: 422,
        statusText: 'Unprocessable',
      });
    await view();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('TOBACCO_SYNC.ERROR.PLACES');
    expect(button('TOBACCO_SYNC.DIALOG.SYNC')).toBeUndefined();
    expect(root.querySelector('fc-confirm-dialog dialog')!.hasAttribute('open')).toBe(false);
  });

  it('starts again from the defaults every time it opens', async () => {
    const { view, check, toggle, box, fixture, text } = render();
    await view();
    await toggle('Bar Alfa');
    await toggle('TOBACCO_SYNC.DIALOG.NO_DISCOUNT');
    await check();
    fixture.componentInstance.open.set(false);
    await view();
    fixture.componentInstance.open.set(true);
    await view();
    expect(box('Bar Alfa').checked).toBe(false);
    expect(box('TOBACCO_SYNC.DIALOG.NO_DISCOUNT').checked).toBe(true);
    expect(text()).not.toContain('TOBACCO_SYNC.DIALOG.VERIFIED_TEXT');
  });

  it('closes with Cancel', async () => {
    const { view, button, fixture } = render();
    await view();
    button('COMMON.CANCEL')!.click();
    await view();
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('closes with the close button of the window', async () => {
    const { view, root, fixture } = render();
    await view();
    root.querySelector<HTMLButtonElement>('fc-dialog header button')!.click();
    await view();
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('closes the confirmation without sending anything', async () => {
    const { view, check, button, root } = render();
    await view();
    await check();
    button('TOBACCO_SYNC.DIALOG.SYNC')!.click();
    await view();
    [...root.querySelectorAll<HTMLButtonElement>('fc-confirm-dialog button')]
      .find((b) => b.textContent?.trim() === 'COMMON.CANCEL')!
      .click();
    await view();
    expect(root.querySelector('fc-confirm-dialog dialog')!.hasAttribute('open')).toBe(false);
    backend().expectNone((r) => !r.params.has('dryRun'));
  });
});
