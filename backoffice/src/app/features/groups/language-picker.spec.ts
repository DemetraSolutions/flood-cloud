import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { LanguagePicker } from './language-picker';
import { ISO_639_1 } from './languages';

async function render(value: string[] = [], inputs: { error?: string; disabled?: boolean } = {}) {
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(LanguagePicker);
  fixture.componentRef.setInput('label', 'Lingue');
  fixture.componentRef.setInput('error', inputs.error ?? null);
  fixture.componentRef.setInput('disabled', inputs.disabled ?? false);
  fixture.componentInstance.value.set(value);
  const emitted: string[][] = [];
  fixture.componentInstance.value.subscribe((v) => emitted.push(v));
  const blurs: true[] = [];
  fixture.componentInstance.blurred.subscribe(() => blurs.push(true));
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const boxes = () => [...root.querySelectorAll<HTMLInputElement>('li input[type=checkbox]')];
  const box = (code: string) =>
    [...root.querySelectorAll<HTMLLabelElement>('li label')]
      .find((l) => l.textContent?.trim().endsWith(`(${code})`))
      ?.querySelector('input');
  const filter = async (text: string) => {
    const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  const click = async (code: string, checked: boolean) => {
    const input = box(code)!;
    input.checked = checked;
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  };
  return { fixture, root, boxes, box, filter, click, emitted, blurs };
}

afterEach(() => vi.restoreAllMocks());

describe('LanguagePicker', () => {
  it('is a group named by the label, with a checkbox for every ISO 639-1 language', async () => {
    const { root, boxes, box } = await render(['it']);
    expect(root.querySelector('legend')?.textContent).toBe('Lingue');
    expect(boxes()).toHaveLength(ISO_639_1.length);
    expect(box('it')?.checked).toBe(true);
    expect(box('en')?.checked).toBe(false);
    expect(root.querySelector('.count')?.getAttribute('role')).toBe('status');
    expect(root.querySelector('.count')?.textContent).toContain('"count":1,"max":10');
  });

  it('adds and removes a language through the value', async () => {
    const { click, emitted } = await render(['it']);
    await click('en', true);
    await click('it', false);
    expect(emitted).toEqual([['it', 'en'], ['en']]);
  });

  it('filters by code and by name and tells when nothing matches', async () => {
    const { root, boxes, box, filter } = await render();
    const label = [...root.querySelectorAll('li label')]
      .find((l) => l.textContent?.trim().endsWith('(ja)'))!
      .textContent!.trim();
    const name = label.slice(0, label.indexOf(' (')).toLowerCase();
    await filter('JA ');
    expect(box('ja')).toBeDefined();
    expect(boxes().length).toBeLessThan(ISO_639_1.length);
    await filter(name);
    expect(box('ja')).toBeDefined();
    expect(boxes().length).toBeLessThan(5);
    await filter('zzzz');
    expect(boxes()).toHaveLength(0);
    expect(root.querySelector('li.none')?.textContent).toContain('LANGUAGE_PICKER.NONE');
    await filter('');
    expect(boxes()).toHaveLength(ISO_639_1.length);
  });

  it('keeps the selection while the list is filtered', async () => {
    const { box, filter, click, emitted } = await render(['it']);
    await filter('en');
    await click('en', true);
    expect(emitted).toEqual([['it', 'en']]);
    await filter('');
    expect(box('it')?.checked).toBe(true);
  });

  it('disables the languages that are not selected once the limit is reached', async () => {
    const chosen = ['it', 'en', 'fr', 'de', 'es', 'pt', 'nl', 'sv', 'da', 'fi'];
    const { box, click, emitted } = await render(chosen);
    expect(box('it')?.disabled).toBe(false);
    expect(box('fi')?.disabled).toBe(false);
    expect(box('ja')?.disabled).toBe(true);
    await click('fi', false);
    expect(emitted.at(-1)).toEqual(chosen.slice(0, 9));
    expect(box('ja')?.disabled).toBe(false);
  });

  it('can be disabled as a whole', async () => {
    const { root, box } = await render(['it'], { disabled: true });
    expect(root.querySelector('fieldset')?.disabled).toBe(true);
    expect(box('it')?.disabled).toBe(true);
    expect(box('en')?.disabled).toBe(true);
  });

  it('shows the error and links it to the group', async () => {
    const { root } = await render([], { error: 'Troppe lingue' });
    const fieldset = root.querySelector('fieldset')!;
    const error = fieldset.querySelector(':scope > .error')!;
    expect(error.textContent).toContain('Troppe lingue');
    expect(fieldset.getAttribute('aria-describedby')).toBe(error.id);
  });

  it('has no description without an error', async () => {
    const { root } = await render();
    expect(root.querySelector('fieldset')?.getAttribute('aria-describedby')).toBeNull();
  });

  it('tells when a checkbox loses the focus', async () => {
    const { box, blurs } = await render();
    box('en')!.dispatchEvent(new Event('blur'));
    expect(blurs).toEqual([true]);
  });

  it('names the languages in the language of the interface, Italian while none is loaded', async () => {
    const { box } = await render();
    expect(box('en')!.closest('label')!.textContent!.trim()).toBe('inglese (en)');
    expect(TestBed.inject(I18nService).language()).toBeNull();
  });

  it('names the languages in the current language of the interface', async () => {
    vi.spyOn(TestBed.inject(I18nService), 'language').mockReturnValue('it');
    const { box } = await render();
    expect(box('fr')!.closest('label')!.textContent!.trim()).toBe('francese (fr)');
  });
});
