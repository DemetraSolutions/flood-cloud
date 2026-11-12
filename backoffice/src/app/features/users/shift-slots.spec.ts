import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { applyEach, disabled, form, required, validate } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { ShiftSlot } from '../../core/users/shift-time';
import { ShiftSlots } from './shift-slots';

@Component({
  imports: [ShiftSlots],
  template: `<fc-shift-slots [slots]="f.slots" dayLabel="Lunedì" />`,
})
class Host {
  readonly model = signal<{ slots: ShiftSlot[] }>({ slots: [] });
  readonly locked = signal(false);
  readonly f = form(this.model, (path) => {
    disabled(path.slots, () => this.locked());
    applyEach(path.slots, (slot) => {
      required(slot.start);
      validate(slot.end, ({ value }) =>
        value() === '99:99' ? { kind: 'server', message: 'Fine non valida' } : undefined,
      );
    });
  });
}

async function render(slots: ShiftSlot[] = []) {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.model.set({ slots });
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  const addButton = () => buttons().find((b) => b.textContent?.includes('USERS.SHIFTS.ADD_SLOT'))!;
  const inputs = () => [...root.querySelectorAll<HTMLInputElement>('input')];
  return { fixture, host: fixture.componentInstance, root, buttons, addButton, inputs };
}

afterEach(() => vi.restoreAllMocks());

describe('ShiftSlots', () => {
  it('shows an empty list with only the add button', async () => {
    const { root, addButton } = await render();
    expect(root.querySelectorAll('li').length).toBe(0);
    expect(addButton().disabled).toBe(false);
  });

  it('labels the fields of each slot with the day and its number', async () => {
    const { root } = await render([
      { start: '08:00', end: '12:00' },
      { start: '14:00', end: '18:00' },
    ]);
    const labels = [...root.querySelectorAll('label')].map((l) => l.textContent?.trim());
    expect(labels).toEqual([
      'USERS.SHIFTS.SLOT_START {"day":"Lunedì","n":1}',
      'USERS.SHIFTS.SLOT_END {"day":"Lunedì","n":1}',
      'USERS.SHIFTS.SLOT_START {"day":"Lunedì","n":2}',
      'USERS.SHIFTS.SLOT_END {"day":"Lunedì","n":2}',
    ]);
    const inputs = root.querySelectorAll<HTMLInputElement>('input');
    expect([...inputs].map((i) => i.type)).toEqual(['time', 'time', 'time', 'time']);
    expect([...inputs].map((i) => i.value)).toEqual(['08:00', '12:00', '14:00', '18:00']);
  });

  it('adds an empty slot', async () => {
    const { fixture, host, addButton, root } = await render();
    addButton().click();
    await fixture.whenStable();
    expect(host.model().slots.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: '', end: '' },
    ]);
    expect(root.querySelectorAll('li').length).toBe(1);
  });

  it('disables the add button at ten slots', async () => {
    const ten = Array.from({ length: 10 }, () => ({ start: '08:00', end: '09:00' }));
    const { fixture, host, addButton } = await render(ten.slice(0, 9));
    expect(addButton().disabled).toBe(false);
    addButton().click();
    await fixture.whenStable();
    expect(host.model().slots.length).toBe(10);
    expect(addButton().disabled).toBe(true);
  });

  it('removes the chosen slot with an accessible button', async () => {
    const { fixture, host, buttons } = await render([
      { start: '08:00', end: '09:00' },
      { start: '10:00', end: '11:00' },
    ]);
    const remove = buttons().filter((b) => b.getAttribute('aria-label') !== null);
    expect(remove.map((b) => b.getAttribute('aria-label'))).toEqual([
      'USERS.SHIFTS.REMOVE_SLOT {"day":"Lunedì","n":1}',
      'USERS.SHIFTS.REMOVE_SLOT {"day":"Lunedì","n":2}',
    ]);
    remove[0].click();
    await fixture.whenStable();
    expect(host.model().slots.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: '10:00', end: '11:00' },
    ]);
  });

  it('hides the buttons when the field is disabled', async () => {
    const { fixture, host, buttons, inputs } = await render([{ start: '08:00', end: '09:00' }]);
    host.locked.set(true);
    await fixture.whenStable();
    expect(buttons().length).toBe(0);
    expect(inputs().every((i) => i.disabled)).toBe(true);
  });

  it('shows client errors only after the field was touched', async () => {
    const { fixture, root, inputs } = await render([{ start: '', end: '09:00' }]);
    expect(root.querySelector('.error span')).toBeNull();
    inputs()[0].dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(root.querySelector('.error span')?.textContent).toBe('FORM.ISSUE.REQUIRED');
    expect(inputs()[0].getAttribute('aria-invalid')).toBe('true');
  });

  it('shows server errors right away and marks the end field as touched on blur', async () => {
    const { fixture, host, root, inputs } = await render([{ start: '08:00', end: '99:99' }]);
    expect(root.querySelector('.error span')?.textContent).toBe('Fine non valida');
    inputs()[1].dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(host.f.slots[0].end().touched()).toBe(true);
  });
});
