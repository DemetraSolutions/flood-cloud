import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { submit } from '@angular/forms/signals';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { findControl, typeInto } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { fakePos, fakeUser } from '../../../testing/users';
import { FEATURE_NAMES } from '../../core/groups/feature-catalog';
import { I18nService } from '../../core/i18n/i18n.service';
import { Role } from '../../core/session/session.types';
import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  POS_GRANT_GROUPS,
  UserPos,
} from '../../core/users/pos.catalog';
import { PosGrantsFields } from './pos-grants-fields';
import { UserFormState } from './user-form-state';

@Component({
  imports: [PosGrantsFields],
  providers: [UserFormState],
  template: `<fc-pos-grants-fields />`,
})
class Host {
  readonly state = inject(UserFormState);
  readonly editing = signal<string | undefined>('u1');
  constructor() {
    this.state.attach(signal('665f1c2e9b1d4a0012ab34a1'), this.editing);
  }
}

const features = Object.fromEntries(FEATURE_NAMES.map((name) => [name, name === 'cash'])) as Record<
  (typeof FEATURE_NAMES)[number],
  boolean
>;

async function render(
  options: {
    role?: Role;
    pos?: UserPos;
    customPos?: boolean;
    manage?: boolean;
    rooms?: boolean;
    userPos?: UserPos;
  } = {},
) {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  signIn({
    role: options.role ?? 'SA',
    permissions: ['users:create', 'users:update'],
    canManagePermissions: options.manage ?? true,
    groupFeatures: { ...features, rooms: options.rooms ?? true },
    pos: options.pos ?? fakePos(),
  });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  const editing = options.customPos ?? true;
  if (!editing) {
    host.editing.set(undefined);
  }
  fixture.detectChanges();
  if (editing) {
    backend()
      .expectOne(`${API}/v1/groups/665f1c2e9b1d4a0012ab34a1/users/u1`)
      .flush({
        data: fakeUser({
          id: 'u1',
          role: 'CA',
          ...(options.userPos === undefined ? {} : { pos: options.userPos }),
        }),
      });
    await settle();
    fixture.detectChanges();
    backend()
      .expectOne(`${API}/v1/groups/665f1c2e9b1d4a0012ab34a1/lookup/price-lists`)
      .flush({ data: [] });
  }
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const topFieldsets = () => [
    ...root.querySelectorAll<HTMLElement>('fc-pos-grants-fields > .stack > fieldset'),
  ];
  const checkboxes = (scope: ParentNode = root) => [
    ...scope.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
  ];
  const hints = (scope: ParentNode = root) =>
    [...scope.querySelectorAll('.hint')]
      .map((hint) => hint.textContent?.trim())
      .filter((hint) => hint === 'USERS.POS.NOT_GRANTABLE');
  return { fixture, host, state: host.state, root, topFieldsets, checkboxes, hints };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
});

describe('PosGrantsFields', () => {
  it('shows the 47 permissions in their five groups and the automatic cash devices', async () => {
    const { topFieldsets, checkboxes, root } = await render();
    const fieldsets = topFieldsets();
    expect(fieldsets.map((f) => f.querySelector('legend')?.textContent)).toEqual([
      ...POS_GRANT_GROUPS.map((group) => `USERS.POS.GRANT_GROUP.${group.id}`),
      'USERS.POS.AUTOMATIC_CASH',
    ]);
    POS_GRANT_GROUPS.forEach((group, index) => {
      expect(checkboxes(fieldsets[index]).length).toBe(group.flags.length);
    });
    const total = POS_GRANT_GROUPS.reduce((sum, group) => sum + group.flags.length, 0);
    expect(total).toBe(47);
    const devices = [...fieldsets[5].querySelectorAll('fieldset')];
    expect(devices.map((d) => d.querySelector('legend')?.textContent)).toEqual(
      AUTOMATIC_CASH_DEVICES.map((device) => `USERS.POS.DEVICE.${deviceKey(device)}`),
    );
    AUTOMATIC_CASH_DEVICES.forEach((device, index) => {
      expect(checkboxes(devices[index]).length).toBe(AUTOMATIC_CASH[device].length);
    });
    expect(root.textContent).toContain('USERS.POS.GRANT.DISCOUNT_REASON');
    expect(root.textContent).toContain('USERS.POS.AUTOMATIC_FLAG.ARCHIVE_ALL');
    expect(checkboxes(fieldsets[5]).length).toBe(7 + 6 + 5 + 4 + 1);
  });

  it('puts the two percentages in the sale group only', async () => {
    const { topFieldsets } = await render();
    const fieldsets = topFieldsets();
    const percentages = (scope: HTMLElement) =>
      [...scope.querySelectorAll<HTMLInputElement>('input[inputmode=decimal]')].length;
    expect(percentages(fieldsets[1])).toBe(2);
    expect(
      percentages(fieldsets[0]) +
        percentages(fieldsets[2]) +
        percentages(fieldsets[3]) +
        percentages(fieldsets[4]),
    ).toBe(0);
    expect(percentages(fieldsets[5])).toBe(0);
    expect(fieldsets[1].textContent).toContain('USERS.POS.DISCOUNT_MAX');
    expect(fieldsets[1].textContent).toContain('USERS.POS.SERVICE_PERCENTAGE');
  });

  it('edits permissions, percentages and automatic flags into the form model', async () => {
    const { fixture, state } = await render();
    const flag = findControl(fixture, 'USERS.POS.GRANT.PRICE_CHANGE') as HTMLInputElement;
    flag.checked = true;
    flag.dispatchEvent(new Event('change'));
    const device = findControl(
      fixture,
      'USERS.POS.AUTOMATIC_FLAG.COLLECT_VERIFY',
    ) as HTMLInputElement;
    device.checked = true;
    device.dispatchEvent(new Event('change'));
    await typeInto(fixture, 'USERS.POS.DISCOUNT_MAX', '15');
    await typeInto(fixture, 'USERS.POS.SERVICE_PERCENTAGE', '10');
    const grants = state.model().pos.grants;
    expect(grants.priceChange).toBe(true);
    expect(grants.automaticCash.glory.collectVerify).toBe(true);
    expect(grants.discountMaxPercentage).toBe('15');
    expect(grants.servicePercentage).toBe('10');
  });

  it('offers "Attiva per palmare" only to a group with rooms', async () => {
    const withRooms = await render();
    expect(withRooms.root.textContent).toContain('USERS.POS.GRANT.HANDHELD_ENABLED');
    expect(withRooms.root.textContent).toContain('USERS.POS.GRANT.CASH_ENABLED');
    expect(withRooms.root.textContent).toContain('USERS.POS.GRANT.HANDHELD_WALLET');
    expect(withRooms.checkboxes().length).toBe(47 + 23);
    withRooms.fixture.destroy();
    backend().verify();
    TestBed.resetTestingModule();
    const without = await render({ rooms: false });
    expect(without.root.textContent).not.toContain('USERS.POS.GRANT.HANDHELD_ENABLED');
    expect(without.root.textContent).toContain('USERS.POS.GRANT.CASH_ENABLED');
    expect(without.checkboxes().length).toBe(46 + 23);
  });

  it('lets an actor whose app grants are missing give the two that are on by default', async () => {
    const pos = fakePos();
    delete (pos.grants as unknown as Record<string, boolean>)['cashEnabled'];
    delete (pos.grants as unknown as Record<string, boolean>)['handheldEnabled'];
    const { fixture } = await render({ role: 'CA', pos });
    expect(
      (findControl(fixture, 'USERS.POS.GRANT.CASH_ENABLED') as HTMLInputElement).disabled,
    ).toBe(false);
    expect(
      (findControl(fixture, 'USERS.POS.GRANT.HANDHELD_WALLET') as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it('does not let an actor give an app switch they have turned off', async () => {
    const pos = fakePos();
    pos.grants.cashEnabled = false;
    const { fixture } = await render({ role: 'CA', pos, userPos: pos });
    expect(
      (findControl(fixture, 'USERS.POS.GRANT.CASH_ENABLED') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (findControl(fixture, 'USERS.POS.GRANT.HANDHELD_ENABLED') as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('shows no hint when the actor can give everything', async () => {
    const { hints, checkboxes } = await render();
    expect(hints().filter((hint) => hint === 'USERS.POS.NOT_GRANTABLE')).toEqual([]);
    expect(checkboxes().every((box) => !box.disabled)).toBe(true);
  });

  it('flags and disables what a limited actor cannot give', async () => {
    const pos = fakePos();
    (pos.grants as unknown as Record<string, boolean>)['discount'] = true;
    pos.grants.automaticCash.glory.withdrawal = true;
    const { fixture, topFieldsets, checkboxes, hints } = await render({ role: 'CA', pos });
    const sale = topFieldsets()[1];
    const discount = findControl(fixture, 'USERS.POS.GRANT.DISCOUNT') as HTMLInputElement;
    expect(discount.disabled).toBe(false);
    const priceChange = findControl(fixture, 'USERS.POS.GRANT.PRICE_CHANGE') as HTMLInputElement;
    expect(priceChange.disabled).toBe(true);
    expect(priceChange.getAttribute('aria-describedby')).toContain('hint');
    expect(hints(sale).length).toBe(9);
    expect(hints(sale).every((hint) => hint === 'USERS.POS.NOT_GRANTABLE')).toBe(true);

    const cash = topFieldsets()[5];
    const glory = findControl(fixture, 'USERS.POS.AUTOMATIC_FLAG.WITHDRAWAL') as HTMLInputElement;
    expect(glory.disabled).toBe(false);
    expect(hints(cash).length).toBe(22);
    expect(checkboxes(cash).filter((box) => !box.disabled).length).toBe(1);
  });

  it('does not flag a permission the user already has, even if the actor lacks it', async () => {
    const { fixture, state, checkboxes, hints } = await render({ role: 'CA' });
    expect(hints().length).toBe(45 + 23);
    const stored = fakePos();
    (stored.grants as unknown as Record<string, boolean>)['discount'] = true;
    stored.grants.automaticCash.vne.tools = true;
    state.apply(fakeUser({ id: '665f1c2e9b1d4a0012ab34ff', pos: stored }));
    fixture.detectChanges();
    backend()
      .match(`${API}/v1/groups/665f1c2e9b1d4a0012ab34a1/lookup/price-lists`)
      .forEach((request) => request.flush({ data: [] }));
    await fixture.whenStable();
    expect(hints().length).toBe(44 + 22);
    expect(checkboxes().filter((box) => box.checked).length).toBe(4);
    expect((findControl(fixture, 'USERS.POS.GRANT.DISCOUNT') as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  it('shows no hints when the permissions are not editable', async () => {
    const { checkboxes, hints } = await render({ customPos: false });
    expect(hints().filter((hint) => hint === 'USERS.POS.NOT_GRANTABLE')).toEqual([]);
    expect(checkboxes().every((box) => box.disabled)).toBe(true);
  });

  it('shows no hints and disables the fields to an actor who cannot manage permissions', async () => {
    const { checkboxes, hints } = await render({ role: 'CA', manage: false });
    expect(hints().filter((hint) => hint === 'USERS.POS.NOT_GRANTABLE')).toEqual([]);
    expect(checkboxes().every((box) => box.disabled)).toBe(true);
  });

  it('shows the errors of the server on the fields', async () => {
    const { fixture, state, root } = await render();
    const grants = state.userForm.pos.grants;
    await submit(state.userForm, {
      ignoreValidators: 'all',
      action: async () => [
        { kind: 'server', fieldTree: grants.discount, message: 'Sconto non consentito' },
        { kind: 'server', fieldTree: grants.automaticCash.glory.deposit, message: 'Deposito no' },
        { kind: 'server', fieldTree: grants.servicePercentage, message: 'Servizio no' },
      ],
    });
    await fixture.whenStable();
    expect(root.textContent).toContain('Sconto non consentito');
    expect(root.textContent).toContain('Deposito no');
    expect(root.textContent).toContain('Servizio no');
    expect(findControl(fixture, 'USERS.POS.GRANT.DISCOUNT').getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('shows the percentage error only after the field loses focus', async () => {
    const { fixture } = await render();
    const input = await typeInto(fixture, 'USERS.POS.DISCOUNT_MAX', 'abc');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const service = await typeInto(fixture, 'USERS.POS.SERVICE_PERCENTAGE', 'abc');
    service.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(service.getAttribute('aria-invalid')).toBe('true');
  });
});

function deviceKey(device: string): string {
  return device.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}
