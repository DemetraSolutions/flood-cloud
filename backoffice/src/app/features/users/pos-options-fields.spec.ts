import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, validate } from '@angular/forms/signals';
import { findControl, typeInto } from '../../../testing/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { POS_BOOLEAN_OPTIONS, POS_OPTION_GROUPS } from '../../core/users/pos.catalog';
import { FavoritesChoice, PosOptionsFields } from './pos-options-fields';
import { blankPos, PosOptionsModel } from './user-model';

@Component({
  imports: [PosOptionsFields],
  template: `<fc-pos-options-fields [options]="f" [favorites]="favorites()" [rooms]="rooms()" />`,
})
class Host {
  readonly model = signal<PosOptionsModel>(blankPos().options);
  readonly favorites = signal<readonly FavoritesChoice[] | null>(null);
  readonly rooms = signal(false);
  readonly f = form(this.model, (path) => {
    validate(path.quickDiscount, ({ value }) =>
      value() !== '' && Number.isNaN(Number(value())) ? { kind: 'pattern' } : undefined,
    );
    validate(path.side, ({ value }) =>
      value() === 'sx' ? { kind: 'server', message: 'Lato non consentito' } : undefined,
    );
  });
}

async function render() {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const host = fixture.componentInstance;
  const root = fixture.nativeElement as HTMLElement;
  const update = async (change: () => void) => {
    change();
    await fixture.whenStable();
  };
  const select = (label: string) => findControl(fixture, label) as HTMLSelectElement;
  const optionsOf = (label: string) =>
    [...select(label).options].map((o) => [o.value, o.textContent?.trim()]);
  return { fixture, host, root, update, select, optionsOf };
}

afterEach(() => vi.restoreAllMocks());

describe('PosOptionsFields', () => {
  it('shows the 33 preferences of the four groups, without the room ones when the group has no rooms', async () => {
    const { root } = await render();
    const fieldsets = [...root.querySelectorAll('.stack > fieldset')];
    const groups = POS_OPTION_GROUPS.filter((group) => group.id !== 'RESTAURANT').map(
      (group) => group.id,
    );
    expect(fieldsets.map((f) => f.querySelector('legend')?.textContent)).toEqual([
      ...groups.map((id) => `USERS.POS.OPTION_GROUP.${id}`),
      'USERS.POS.CHOICES',
    ]);
    POS_OPTION_GROUPS.filter((group) => group.id !== 'RESTAURANT').forEach((group, index) => {
      const boxes = fieldsets[index].querySelectorAll('input[type=checkbox]');
      expect(boxes.length).toBe(group.flags.length);
    });
    expect(root.querySelectorAll('input[type=checkbox]').length).toBe(33);
    expect(POS_BOOLEAN_OPTIONS.length).toBe(34);
    expect(root.textContent).not.toContain('USERS.POS.OPTION.ROOMS_LEGEND');
    expect(root.textContent).not.toContain('USERS.POS.CHOICE.HANDHELD_TEXT_ZOOM');
    // The product colour sits with the product preferences.
    expect(fieldsets[1].textContent).toContain('USERS.POS.CHOICE.PRODUCTS_COLOR_STYLE');
  });

  it('shows the restaurant preferences and the "Palmare 2.0" group for a group with rooms', async () => {
    const { root, host, update, optionsOf, fixture } = await render();
    await update(() => host.rooms.set(true));
    const legends = [...root.querySelectorAll('legend')].map((l) => l.textContent);
    expect(legends).toContain('USERS.POS.OPTION_GROUP.RESTAURANT');
    expect(legends).toContain('USERS.POS.OPTION_GROUP.HANDHELD');
    expect(root.querySelectorAll('input[type=checkbox]').length).toBe(34);
    const legend = findControl(fixture, 'USERS.POS.OPTION.ROOMS_LEGEND') as HTMLInputElement;
    legend.checked = true;
    legend.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(host.model().roomsLegend).toBe(true);
    expect(optionsOf('USERS.POS.CHOICE.PRODUCTS_COLOR_STYLE')).toEqual([
      ['line', 'USERS.POS.CHOICE_VALUE.PRODUCTS_COLOR_STYLE.LINE'],
      ['fill', 'USERS.POS.CHOICE_VALUE.PRODUCTS_COLOR_STYLE.FILL'],
    ]);
    expect(optionsOf('USERS.POS.CHOICE.HANDHELD_TEXT_ZOOM').map(([value]) => value)).toEqual([
      '85',
      '90',
      '95',
      '100',
      '105',
      '110',
      '115',
      '120',
      '125',
    ]);
    expect(optionsOf('USERS.POS.CHOICE.HANDHELD_TEXT_ZOOM')[3]).toEqual(['100', '100 %']);
    expect(optionsOf('USERS.POS.CHOICE.HANDHELD_CATEGORIES_LAYOUT')).toEqual([
      ['scroll', 'USERS.POS.CHOICE_VALUE.HANDHELD_CATEGORIES_LAYOUT.SCROLL'],
      ['slidein', 'USERS.POS.CHOICE_VALUE.HANDHELD_CATEGORIES_LAYOUT.SLIDEIN'],
      ['list', 'USERS.POS.CHOICE_VALUE.HANDHELD_CATEGORIES_LAYOUT.LIST'],
    ]);
    expect(optionsOf('USERS.POS.CHOICE.HANDHELD_CATEGORIES_ROWS')).toEqual([
      ['1', '1'],
      ['2', '2'],
    ]);
    expect(optionsOf('USERS.POS.CHOICE.HANDHELD_PRODUCTS_COLUMNS')[0]).toEqual([
      '1',
      'USERS.POS.CHOICE_VALUE.HANDHELD_PRODUCTS_COLUMNS.1',
    ]);
    expect(optionsOf('USERS.POS.CHOICE.HANDHELD_MENU_POSITION').map(([v]) => v)).toEqual([
      'bottom',
      'top',
    ]);
  });

  it('edits a preference through its checkbox', async () => {
    const { fixture, host } = await render();
    const box = findControl(fixture, 'USERS.POS.OPTION.DARK_MODE') as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(host.model().darkMode).toBe(true);
  });

  it('offers the right values for every choice, with "none" for the empty one', async () => {
    const { select, optionsOf } = await render();
    expect(optionsOf('USERS.POS.CHOICE.SIDE')).toEqual([
      ['dx', 'USERS.POS.CHOICE_VALUE.SIDE.DX'],
      ['sx', 'USERS.POS.CHOICE_VALUE.SIDE.SX'],
    ]);
    expect(optionsOf('USERS.POS.CHOICE.SIDE_ROOMS').map(([v]) => v)).toEqual(['dx', 'sx']);
    expect(optionsOf('USERS.POS.CHOICE.VIRTUAL_KEYBOARD')).toEqual([
      ['', 'USERS.POS.CHOICE_NONE'],
      ['pb', 'USERS.POS.CHOICE_VALUE.VIRTUAL_KEYBOARD.PB'],
      ['p', 'USERS.POS.CHOICE_VALUE.VIRTUAL_KEYBOARD.P'],
      ['mb', 'USERS.POS.CHOICE_VALUE.VIRTUAL_KEYBOARD.MB'],
      ['m', 'USERS.POS.CHOICE_VALUE.VIRTUAL_KEYBOARD.M'],
    ]);
    expect(optionsOf('USERS.POS.CHOICE.TEMPLATE')).toEqual([
      ['', 'USERS.POS.CHOICE_NONE'],
      ['material-tealwhite-light', 'USERS.POS.CHOICE_VALUE.TEMPLATE.MATERIAL_TEALWHITE_LIGHT'],
      ['material-tealwhite-dark', 'USERS.POS.CHOICE_VALUE.TEMPLATE.MATERIAL_TEALWHITE_DARK'],
      ['material-whitepurple-light', 'USERS.POS.CHOICE_VALUE.TEMPLATE.MATERIAL_WHITEPURPLE_LIGHT'],
      ['material-whitepurple-dark', 'USERS.POS.CHOICE_VALUE.TEMPLATE.MATERIAL_WHITEPURPLE_DARK'],
    ]);
    expect(optionsOf('USERS.POS.CHOICE.PRODUCTS_FONT_SIZE').map(([v]) => v)).toEqual([
      's',
      'm',
      'l',
    ]);
    expect(optionsOf('USERS.POS.CHOICE.PRODUCTS_SHORT_NAME_FONT_SIZE').map(([v]) => v)).toEqual([
      's',
      'm',
      'l',
    ]);
    expect(optionsOf('USERS.POS.CHOICE.ROOMS_TABLES_COLUMNS')).toEqual([
      ['', 'USERS.POS.CHOICE_NONE'],
      ['4', '4'],
      ['5', '5'],
      ['6', '6'],
      ['8', '8'],
    ]);
    expect(optionsOf('USERS.POS.CHOICE.ROOMS_TABLES_COLUMNS_HANDHELD')).toEqual([
      ['', 'USERS.POS.CHOICE_NONE'],
      ['2', '2'],
      ['3', '3'],
      ['4', '4'],
    ]);
    expect(optionsOf('USERS.POS.CHOICE.ROOMS_GRID_ZOOM_HANDHELD')).toEqual([
      ['1', '1x'],
      ['1.5', '1.5x'],
      ['2', '2x'],
      ['2.5', '2.5x'],
      ['3', '3x'],
    ]);
    expect(select('USERS.POS.CHOICE.SIDE').required).toBe(false);
  });

  it('changes a choice', async () => {
    const { fixture, host, select } = await render();
    const side = select('USERS.POS.CHOICE.SIDE');
    side.value = 'dx';
    side.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(host.model().side).toBe('dx');
  });

  it('offers only the real values of a choice, with no default placeholder', async () => {
    const { optionsOf } = await render();
    expect(optionsOf('USERS.POS.CHOICE.SIDE')).toEqual([
      ['dx', 'USERS.POS.CHOICE_VALUE.SIDE.DX'],
      ['sx', 'USERS.POS.CHOICE_VALUE.SIDE.SX'],
    ]);
  });

  it('shows the error of the server on a choice', async () => {
    const { fixture, host, root, update } = await render();
    await update(() => host.model.update((model) => ({ ...model, side: 'sx' })));
    const select = findControl(fixture, 'USERS.POS.CHOICE.SIDE');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(root.textContent).toContain('Lato non consentito');
  });

  it('shows the quick discount error only after the field loses focus', async () => {
    const { fixture, root } = await render();
    const label = 'USERS.POS.OPTION.QUICK_DISCOUNT';
    const input = (await typeInto(fixture, label, 'abc')) as HTMLInputElement;
    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect(root.textContent).toContain('USERS.POS.PERCENT_HINT');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(root.textContent).toContain('FORM.ISSUE.PATTERN');
  });

  it('shows nothing about favorites when unreadable and not set', async () => {
    const { root } = await render();
    expect(root.textContent).not.toContain('USERS.POS.OPTION.FAVORITES_ID');
    expect(root.textContent).not.toContain('USERS.POS.FAVORITES_UNREADABLE');
    expect(root.querySelector('p.note')).toBeNull();
  });

  it('notes the stored favorites list when it cannot be read', async () => {
    const { host, root, update } = await render();
    await update(() => host.model.update((model) => ({ ...model, favoritesId: 'fav-7' })));
    expect(root.querySelector('p.note')?.textContent?.trim()).toBe(
      'USERS.POS.FAVORITES_UNREADABLE {"id":"fav-7"}',
    );
    expect(root.querySelectorAll('select').length).toBe(10);
  });

  it('chooses the favorites list among those of the group', async () => {
    const { fixture, host, update, select, optionsOf, root } = await render();
    await update(() =>
      host.favorites.set([
        { id: 'f1', name: 'Bar' },
        { id: 'f2', name: 'Sala' },
      ]),
    );
    expect(optionsOf('USERS.POS.OPTION.FAVORITES_ID')).toEqual([
      ['', 'USERS.POS.FAVORITES_NONE'],
      ['f1', 'Bar'],
      ['f2', 'Sala'],
    ]);
    expect(root.querySelector('p.note')).toBeNull();
    const favorites = select('USERS.POS.OPTION.FAVORITES_ID');
    favorites.value = 'f2';
    favorites.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(host.model().favoritesId).toBe('f2');
  });

  it('shows the favorites select with only the placeholder when the group has none', async () => {
    const { host, update, optionsOf } = await render();
    await update(() => host.favorites.set([]));
    expect(optionsOf('USERS.POS.OPTION.FAVORITES_ID')).toEqual([['', 'USERS.POS.FAVORITES_NONE']]);
  });

  it('has no favorites choices while the lists are unreadable', async () => {
    // The template never reads the choices in that state: this checks the computed on its own.
    const { fixture } = await render();
    const component = fixture.debugElement.children[0].componentInstance as {
      favoriteOptions(): unknown[];
    };
    expect(component.favoriteOptions()).toEqual([]);
  });
});
