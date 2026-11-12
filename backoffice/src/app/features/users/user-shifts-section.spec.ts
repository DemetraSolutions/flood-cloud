import { Component, inject, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { backend, provideApiTesting, settle } from '../../../testing/api';
import { findControl } from '../../../testing/forms';
import { signIn } from '../../../testing/session';
import { I18nService } from '../../core/i18n/i18n.service';
import { Profile } from '../../core/session/session.types';
import { emptyWeek, MAX_SHIFT_SPECIAL_DAYS, MAX_SHIFT_WEEKS } from '../../core/users/shift-time';
import { UserFormState } from './user-form-state';
import { UserShiftsSection } from './user-shifts-section';
import { UsersApi } from './users-api';

/** Plain data of a form value (the form tags list items with a symbol). */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const GROUP = '665f1c2e9b1d4a0012ab34a1';

@Component({
  imports: [UserShiftsSection],
  providers: [UserFormState],
  template: `<fc-user-shifts-section />`,
})
class Host {
  readonly state = inject(UserFormState);
  readonly groupId = signal<string | undefined>(GROUP);
  readonly userId = signal<string | undefined>(undefined);

  constructor() {
    this.state.attach(this.groupId, this.userId);
  }
}

async function render(profile: Partial<Profile> = {}) {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  vi.spyOn(UsersApi.prototype, 'isUsernameAvailable').mockResolvedValue(true);
  signIn({ role: 'SA', permissions: ['users:read', 'users:create'], ...profile });
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await settle();
  const root = fixture.nativeElement as HTMLElement;
  const state = fixture.componentInstance.state;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const button = (label: string, scope: ParentNode = root) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label,
    );
  const click = async (label: string, scope: ParentNode = root) => {
    button(label, scope)!.click();
    await view();
  };
  const type = async (label: string, value: string, scope: ParentNode = root) => {
    const control = findControl({ nativeElement: scope } as ComponentFixture<unknown>, label);
    control.value = value;
    control.dispatchEvent(new Event('input'));
    await view();
    return control;
  };
  const blur = async (control: HTMLElement) => {
    control.dispatchEvent(new Event('blur'));
    await view();
  };
  const weeks = () => [
    ...root.querySelectorAll<HTMLElement>('section[aria-labelledby=shift-weeks] > fieldset'),
  ];
  const specials = () => [
    ...root.querySelectorAll<HTMLElement>('section[aria-labelledby=shift-special] > fieldset'),
  ];
  const legend = (element: Element) => element.querySelector(':scope > legend')?.textContent;
  return { fixture, state, root, view, button, click, type, blur, weeks, specials, legend };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('UserShiftsSection: switch', () => {
  it('turns the shifts on and off', async () => {
    const { root, state, view } = await render();
    const box = findControl(
      { nativeElement: root } as never,
      'USERS.SHIFTS.ENABLED',
    ) as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await view();
    expect(state.model().shiftTime.enabled).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await view();
    expect(state.model().shiftTime.enabled).toBe(false);
  });

  it('shows the headings and the hints of the two lists, empty at first', async () => {
    const { root, weeks, specials } = await render();
    expect(root.querySelector('#shift-weeks')?.textContent).toBe('USERS.SHIFTS.WEEKS');
    expect(root.querySelector('#shift-special')?.textContent).toBe('USERS.SHIFTS.SPECIAL');
    expect(root.textContent).toContain('USERS.SHIFTS.WEEKS_HINT');
    expect(root.textContent).toContain('USERS.SHIFTS.SPECIAL_HINT');
    expect(weeks()).toHaveLength(0);
    expect(specials()).toHaveLength(0);
  });
});

describe('UserShiftsSection: weeks', () => {
  it('adds a default week with the seven days, Monday first and Sunday last', async () => {
    const { click, weeks, legend, state } = await render();
    await click('USERS.SHIFTS.ADD_WEEK');
    expect(weeks()).toHaveLength(1);
    expect(legend(weeks()[0])).toBe('USERS.SHIFTS.WEEK_DEFAULT');
    const days = [...weeks()[0].querySelectorAll('.days > fieldset > legend')].map(
      (l) => l.textContent,
    );
    expect(days).toEqual(
      ['1', '2', '3', '4', '5', '6', '0'].map((key) => `USERS.SHIFTS.DAY.${key}`),
    );
    expect(plain(state.model().shiftTime.weeks)).toEqual([emptyWeek()]);
  });

  it('maps each day to the key of the API: Monday is 1 and Sunday is 0', async () => {
    const { click, weeks, view, state } = await render();
    await click('USERS.SHIFTS.ADD_WEEK');
    const boxes = [
      ...weeks()[0].querySelectorAll<HTMLInputElement>('.days > fieldset > fc-checkbox input'),
    ];
    expect(boxes).toHaveLength(7);
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event('change'));
    await view();
    const active = (key: string) => state.model().shiftTime.weeks[0].days[key as '0'].active;
    expect(active('1')).toBe(true);
    expect(active('0')).toBe(false);
    boxes[6].checked = true;
    boxes[6].dispatchEvent(new Event('change'));
    await view();
    expect(active('0')).toBe(true);
    expect(['2', '3', '4', '5', '6'].some(active)).toBe(false);
  });

  it('titles a week with dates by its position and fills its dates', async () => {
    const { click, weeks, type, legend, state } = await render();
    await click('USERS.SHIFTS.ADD_WEEK');
    await click('USERS.SHIFTS.ADD_WEEK');
    expect(legend(weeks()[1])).toBe('USERS.SHIFTS.WEEK_DEFAULT');
    await type('USERS.SHIFTS.FROM', '2026-12-01', weeks()[1]);
    await type('USERS.SHIFTS.TO', '2026-12-31', weeks()[1]);
    expect(legend(weeks()[1])).toBe('USERS.SHIFTS.WEEK_N {"n":2}');
    expect(state.model().shiftTime.weeks[1]).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(legend(weeks()[0])).toBe('USERS.SHIFTS.WEEK_DEFAULT');
  });

  it('titles a week with only one date by its position', async () => {
    const { click, weeks, type, legend } = await render();
    await click('USERS.SHIFTS.ADD_WEEK');
    await type('USERS.SHIFTS.FROM', '2026-12-01', weeks()[0]);
    expect(legend(weeks()[0])).toBe('USERS.SHIFTS.WEEK_N {"n":1}');
  });

  it('removes the week whose button was clicked', async () => {
    const { click, weeks, button, type, state, view } = await render();
    await click('USERS.SHIFTS.ADD_WEEK');
    await click('USERS.SHIFTS.ADD_WEEK');
    await type('USERS.SHIFTS.FROM', '2026-12-01', weeks()[1]);
    await type('USERS.SHIFTS.TO', '2026-12-31', weeks()[1]);
    button('USERS.SHIFTS.REMOVE_WEEK', weeks()[0])!.click();
    await view();
    expect(weeks()).toHaveLength(1);
    expect(state.model().shiftTime.weeks[0].from).toBe('2026-12-01');
  });

  it('stops adding weeks at the limit of the backend', async () => {
    const { click, button, weeks, root } = await render();
    for (let i = 0; i < MAX_SHIFT_WEEKS; i++) {
      expect(button('USERS.SHIFTS.ADD_WEEK')!.disabled).toBe(false);
      await click('USERS.SHIFTS.ADD_WEEK');
    }
    expect(weeks()).toHaveLength(MAX_SHIFT_WEEKS);
    expect(button('USERS.SHIFTS.ADD_WEEK', root)!.disabled).toBe(true);
  });

  it('shows the error of the week block with role alert once touched', async () => {
    const { click, weeks, root, blur, view } = await render();
    await click('USERS.SHIFTS.ADD_WEEK');
    await click('USERS.SHIFTS.ADD_WEEK');
    expect(root.querySelector('[role=alert]')).toBeNull();
    await blur(findControl({ nativeElement: weeks()[1] } as never, 'USERS.SHIFTS.FROM'));
    await view();
    const alert = weeks()[1].querySelector('p.problem[role=alert]');
    expect(alert?.textContent).toContain('FORM.ISSUE.INCORRECT');
    expect(weeks()[0].querySelector('[role=alert]')).toBeNull();
  });

  it('reports overlapping dated weeks', async () => {
    const { click, weeks, type, blur } = await render();
    await click('USERS.SHIFTS.ADD_WEEK');
    await click('USERS.SHIFTS.ADD_WEEK');
    await type('USERS.SHIFTS.FROM', '2026-12-01', weeks()[0]);
    await type('USERS.SHIFTS.TO', '2026-12-20', weeks()[0]);
    const from = await type('USERS.SHIFTS.FROM', '2026-12-10', weeks()[1]);
    await type('USERS.SHIFTS.TO', '2026-12-31', weeks()[1]);
    await blur(from);
    expect(weeks()[1].querySelector('[role=alert]')?.textContent).toContain('FORM.ISSUE.INCORRECT');
  });

  it('shows the error of a date field once touched', async () => {
    const { click, weeks, type, blur } = await render();
    await click('USERS.SHIFTS.ADD_WEEK');
    await type('USERS.SHIFTS.FROM', '2026-12-31', weeks()[0]);
    const to = await type('USERS.SHIFTS.TO', '2026-12-01', weeks()[0]);
    expect(weeks()[0].querySelector('.error')?.textContent?.trim()).toBe('');
    await blur(to);
    const messages = [...weeks()[0].querySelectorAll('.grid .error')].map((e) =>
      e.textContent?.trim(),
    );
    expect(messages).toEqual(['', 'FORM.ISSUE.INCORRECT']);
  });

  it('edits the time ranges of a day, reporting an end that is not after the start', async () => {
    const { click, weeks, type, blur, button, state, view } = await render();
    await click('USERS.SHIFTS.ADD_WEEK');
    const monday = weeks()[0].querySelector<HTMLElement>('.days > fieldset')!;
    await click('USERS.SHIFTS.ADD_SLOT', monday);
    const label = (part: string) => `USERS.SHIFTS.SLOT_${part} {"day":"USERS.SHIFTS.DAY.1","n":1}`;
    await type(label('START'), '10:00', monday);
    const end = await type(label('END'), '09:00', monday);
    await blur(end);
    expect(monday.textContent).toContain('FORM.ISSUE.INCORRECT');
    expect(plain(state.model().shiftTime.weeks[0].days['1'].slots)).toEqual([
      { start: '10:00', end: '09:00' },
    ]);
    await type(label('END'), '12:00', monday);
    expect(monday.textContent).not.toContain('FORM.ISSUE.INCORRECT');
    button('USERS.SHIFTS.REMOVE', monday)!.click();
    await view();
    expect(plain(state.model().shiftTime.weeks[0].days['1'].slots)).toEqual([]);
  });
});

describe('UserShiftsSection: special days', () => {
  it('adds a special day with its date, day off and ranges, and removes it', async () => {
    const { click, specials, type, legend, state, view, button } = await render();
    await click('USERS.SHIFTS.ADD_SPECIAL');
    expect(specials()).toHaveLength(1);
    expect(legend(specials()[0])).toBe('USERS.SHIFTS.SPECIAL_N {"n":1}');
    await type('USERS.SHIFTS.DATE', '2026-12-25', specials()[0]);
    const off = findControl(
      { nativeElement: specials()[0] } as never,
      'USERS.SHIFTS.DAY_OFF',
    ) as HTMLInputElement;
    off.checked = true;
    off.dispatchEvent(new Event('change'));
    await view();
    await click('USERS.SHIFTS.ADD_SLOT', specials()[0]);
    await type(
      'USERS.SHIFTS.SLOT_START {"day":"USERS.SHIFTS.SPECIAL_N {\\"n\\":1}","n":1}',
      '08:00',
      specials()[0],
    );
    expect(plain(state.model().shiftTime.specialDays)).toEqual([
      { date: '2026-12-25', dayOff: true, slots: [{ start: '08:00', end: '' }] },
    ]);
    await click('USERS.SHIFTS.ADD_SPECIAL');
    expect(legend(specials()[1])).toBe('USERS.SHIFTS.SPECIAL_N {"n":2}');
    button('USERS.SHIFTS.REMOVE_SPECIAL', specials()[0])!.click();
    await view();
    expect(specials()).toHaveLength(1);
    expect(state.model().shiftTime.specialDays[0].date).toBe('');
  });

  it('shows the error of the date once touched, for a repeated date', async () => {
    const { click, specials, type, blur } = await render();
    await click('USERS.SHIFTS.ADD_SPECIAL');
    await click('USERS.SHIFTS.ADD_SPECIAL');
    await type('USERS.SHIFTS.DATE', '2026-12-25', specials()[0]);
    const second = await type('USERS.SHIFTS.DATE', '2026-12-25', specials()[1]);
    await blur(second);
    expect(specials()[1].querySelector('.grid .error')?.textContent).toContain(
      'FORM.ISSUE.INCORRECT',
    );
  });

  it('stops adding special days at the limit of the backend', async () => {
    const { state, view, button } = await render();
    state.model.update((model) => ({
      ...model,
      shiftTime: {
        ...model.shiftTime,
        specialDays: Array.from({ length: MAX_SHIFT_SPECIAL_DAYS }, (_, i) => ({
          date: `d${i}`,
          dayOff: true,
          slots: [],
        })),
      },
    }));
    await view();
    expect(button('USERS.SHIFTS.ADD_SPECIAL')!.disabled).toBe(true);
    state.model.update((model) => ({
      ...model,
      shiftTime: { ...model.shiftTime, specialDays: model.shiftTime.specialDays.slice(1) },
    }));
    await view();
    expect(button('USERS.SHIFTS.ADD_SPECIAL')!.disabled).toBe(false);
  });
});

describe('UserShiftsSection: without the permission to write', () => {
  it('shows the values but offers no button to add or remove anything', async () => {
    const { state, view, root } = await render({ permissions: ['users:read'] });
    state.model.update((model) => ({
      ...model,
      shiftTime: {
        enabled: true,
        weeks: [emptyWeek()],
        specialDays: [
          { date: '2026-12-25', dayOff: false, slots: [{ start: '08:00', end: '09:00' }] },
        ],
      },
    }));
    await view();
    expect(root.querySelector('fieldset.block')).not.toBeNull();
    expect(root.querySelector('button')).toBeNull();
    const box = findControl(
      { nativeElement: root } as never,
      'USERS.SHIFTS.ENABLED',
    ) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });
});
