import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, validate } from '@angular/forms/signals';
import { provideRouter } from '@angular/router';
import { settle } from '../../../testing/api';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { SelectOption } from '../../shared/ui/select/select';
import { QUICK_COLORS } from '../product-categories/category.types';
import { CoreModel, toModel } from './product-model';
import { ProductGeneral } from './product-general';
import { PRODUCT_FEATURES, ProductFeatures, ProductWarning } from './product.types';

const features = (on: boolean, change: Partial<ProductFeatures> = {}): ProductFeatures =>
  ({ ...Object.fromEntries(PRODUCT_FEATURES.map((name) => [name, on])), ...change }) as unknown as ProductFeatures;

const BRANDS: SelectOption[] = [{ value: 'b1', label: 'Marca' }];
const UNITS: SelectOption[] = [{ value: 'kg', label: 'Chilo' }];

@Component({
  imports: [ProductGeneral],
  template: `<fc-product-general
    [form]="productForm"
    groupId="g1"
    [features]="features()"
    [languages]="languages()"
    [requiredLang]="requiredLang()"
    [types]="types()"
    [modifier]="modifier()"
    [service]="service()"
    [quick]="quick()"
    [readOnly]="readOnly()"
    [brands]="brands"
    [units]="units"
    [warnings]="warnings()"
  />`,
})
class Host {
  readonly model = signal<CoreModel>(toModel(null, ['it', 'en'], { type: 'product', prices: [], places: [] }).core);
  readonly productForm = form(this.model, (path) => {
    validate(path.code, ({ value }) => (value() === '' ? { kind: 'required' } : undefined));
  });
  readonly features = signal(features(true));
  readonly languages = signal(['it', 'en']);
  readonly requiredLang = signal('it');
  readonly types = signal<readonly string[]>(['product', 'exempt']);
  readonly modifier = signal(true);
  readonly service = signal(true);
  readonly quick = signal(false);
  readonly readOnly = signal(false);
  readonly warnings = signal<readonly ProductWarning[]>([]);
  readonly brands = BRANDS;
  readonly units = UNITS;
}

async function render(language?: string) {
  const lookupNames = vi.fn().mockResolvedValue({ p1: 'Pizza', p2: 'Pasta' });
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: ReferenceApi, useValue: { lookupNames } }],
  });
  const i18n = TestBed.inject(I18nService);
  if (language !== undefined) {
    Object.defineProperty(i18n, 'language', { value: signal(language).asReadonly() });
  }
  vi.spyOn(i18n, 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  await view();
  const root = fixture.nativeElement as HTMLElement;
  const legends = () => [...root.querySelectorAll('legend')].map((legend) => legend.textContent?.trim());
  const labels = () => [...root.querySelectorAll('label')].map((label) => label.textContent?.trim());
  const control = (label: string) =>
    root.querySelector<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(
      `#${[...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!.htmlFor}`,
    )!;
  const type = async (label: string, value: string) => {
    const element = control(label);
    element.value = value;
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input'));
    await view();
  };
  return { host: fixture.componentInstance, root, view, legends, labels, control, type };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductGeneral', () => {
  it('shows every card when the group has every feature', async () => {
    const { legends } = await render();
    expect(legends()).toEqual([
      'PRODUCTS.CARD.STATE',
      'PRODUCT_CATEGORIES.INTEGRATIONS.TITLE',
      'PRODUCTS.CARD.SERVICE',
      'PRODUCTS.CARD.MODIFIER',
      'PRODUCTS.CARD.UNITS',
      'PRODUCTS.CARD.SCALES',
      'PRODUCT_CATEGORIES.COLORS.TITLE',
      'PRODUCT_CATEGORIES.DINING.TITLE',
      'PRODUCTS.CARD.PERIOD',
    ]);
  });

  it('shows only the cards that need no feature when the group has none', async () => {
    const { host, legends, labels, view } = await render();
    host.features.set(features(false));
    await view();
    expect(legends()).toEqual(['PRODUCTS.CARD.STATE', 'PRODUCT_CATEGORIES.INTEGRATIONS.TITLE', 'PRODUCTS.CARD.PERIOD']);
    for (const label of [
      'PRODUCTS.FIELD.FAVORITE_HANDHELD',
      'PRODUCT_CATEGORIES.FIELD.POS',
      'PRODUCTS.FIELD.WAREHOUSE',
      'PRODUCT_CATEGORIES.FIELD.ECOMMERCE',
      'PRODUCT_CATEGORIES.FIELD.FEATURED',
    ]) {
      expect(labels(), label).not.toContain(label);
    }
  });

  it('shows the switches of each feature', async () => {
    const { labels } = await render();
    for (const label of [
      'PRODUCTS.FIELD.FAVORITE_HANDHELD',
      'PRODUCT_CATEGORIES.FIELD.POS',
      'PRODUCTS.FIELD.WAREHOUSE',
      'PRODUCT_CATEGORIES.FIELD.ECOMMERCE',
      'PRODUCT_CATEGORIES.FIELD.FEATURED',
    ]) {
      expect(labels(), label).toContain(label);
    }
  });

  it('leaves out the service card for a product that is not a service or a group without services', async () => {
    const { host, legends, view } = await render();
    host.service.set(false);
    await view();
    expect(legends()).not.toContain('PRODUCTS.CARD.SERVICE');
    host.service.set(true);
    host.features.set(features(true, { services: false }));
    await view();
    expect(legends()).not.toContain('PRODUCTS.CARD.SERVICE');
  });

  it('leaves out the modifier card for a product that is not a modifier or a group without variants', async () => {
    const { host, legends, view } = await render();
    host.modifier.set(false);
    await view();
    expect(legends()).not.toContain('PRODUCTS.CARD.MODIFIER');
    host.modifier.set(true);
    host.features.set(features(true, { productsVariants: false }));
    await view();
    expect(legends()).not.toContain('PRODUCTS.CARD.MODIFIER');
  });

  it('leaves out the units without warehouse, the scales without scales and the restaurant card without rooms', async () => {
    const { host, legends, view } = await render();
    host.features.set(features(true, { warehouse: false }));
    await view();
    expect(legends()).not.toContain('PRODUCTS.CARD.UNITS');
    host.features.set(features(true, { scales: false }));
    await view();
    expect(legends()).not.toContain('PRODUCTS.CARD.SCALES');
    host.features.set(features(true, { rooms: false }));
    await view();
    expect(legends()).not.toContain('PRODUCT_CATEGORIES.DINING.TITLE');
    host.features.set(features(true, { cash: false }));
    await view();
    expect(legends()).not.toContain('PRODUCT_CATEGORIES.COLORS.TITLE');
  });

  it('leaves out scales and restaurant in the quick view and the period without advanced products', async () => {
    const { host, legends, view } = await render();
    host.quick.set(true);
    await view();
    expect(legends()).not.toContain('PRODUCTS.CARD.SCALES');
    expect(legends()).not.toContain('PRODUCT_CATEGORIES.DINING.TITLE');
    expect(legends()).toContain('PRODUCTS.CARD.PERIOD');
    host.features.set(features(true, { advancedProducts: false }));
    await view();
    expect(legends()).not.toContain('PRODUCTS.CARD.PERIOD');
  });

  it('offers the types, and no choice when there is only one', async () => {
    const { host, control, labels, view } = await render();
    expect([...control('PRODUCTS.FIELD.TYPE').options].map((option) => [option.value, option.textContent?.trim()])).toEqual([
      ['product', 'PRODUCTS.TYPE.PRODUCT'],
      ['exempt', 'PRODUCTS.TYPE.EXEMPT'],
    ]);
    host.types.set(['service']);
    await view();
    expect(labels()).not.toContain('PRODUCTS.FIELD.TYPE');
  });

  it('offers the brands, the units, the kinds of scale and of modifier', async () => {
    const { control } = await render();
    const values = (label: string) => [...control(label).options].map((option) => option.value);
    expect(values('PRODUCTS.FIELD.BRAND')).toEqual(['', 'b1']);
    expect(values('PRODUCTS.FIELD.LOAD_UNIT')).toEqual(['', 'kg']);
    expect(values('PRODUCTS.FIELD.UNLOAD_UNIT')).toEqual(['', 'kg']);
    expect(values('PRODUCTS.FIELD.SCALE_TYPE')).toEqual(['weight', 'piece']);
    expect(values('PRODUCTS.MODIFIER.TYPE')).toEqual(['addRemove', 'add', 'remove', 'info']);
    expect([...control('PRODUCTS.MODIFIER.TYPE').options][3].textContent?.trim()).toBe('PRODUCTS.MODIFIER.TYPE_INFO');
    expect([...control('PRODUCTS.FIELD.SCALE_TYPE').options][1].textContent?.trim()).toBe('PRODUCTS.SCALES.PIECE');
  });

  it('writes what the user types into the form and the switches too', async () => {
    const { host, control, type, view } = await render();
    await type('PRODUCTS.FIELD.CODE', 'A1');
    await type('PRODUCTS.FIELD.BRAND', 'b1');
    await type('PRODUCTS.FIELD.NAME_IN {"language":"italiano"}', 'Pizza');
    await type('PRODUCTS.FIELD.DESCRIPTION_IN {"language":"inglese"}', 'Tasty');
    expect(host.model().code).toBe('A1');
    expect(host.model().brandId).toBe('b1');
    expect(host.model().name['it']).toBe('Pizza');
    expect(host.model().description['en']).toBe('Tasty');
    const box = control('PRODUCTS.FIELD.FAVORITE');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await view();
    expect(host.model().favorite).toBe(true);
  });

  it('labels the texts by language and asks for the name in the required one only', async () => {
    const { root, labels } = await render();
    for (const field of ['NAME', 'SHORT_NAME', 'SHORT_DESCRIPTION', 'DESCRIPTION', 'MODIFIER_DESCRIPTION']) {
      expect(labels()).toContain(`PRODUCTS.FIELD.${field}_IN {"language":"italiano"}`);
      expect(labels()).toContain(`PRODUCTS.FIELD.${field}_IN {"language":"inglese"}`);
    }
    const hints = [...root.querySelectorAll('.hint')].map((hint) => hint.textContent?.trim());
    expect(hints.filter((hint) => hint === 'PRODUCT_CATALOG.FIELD.REQUIRED_LANGUAGE')).toHaveLength(1);
  });

  it('names the languages in the language of the app', async () => {
    const { labels } = await render('en');
    expect(labels()).toContain('PRODUCTS.FIELD.NAME_IN {"language":"Italian"}');
  });

  it('shows the error of a field once it is touched, and marks it touched on blur', async () => {
    const { host, root, control, view } = await render();
    const message = () => root.querySelector('.error span')?.textContent;
    expect(message()).toBeUndefined();
    control('PRODUCTS.FIELD.CODE').dispatchEvent(new Event('blur'));
    await view();
    expect(host.productForm.code().touched()).toBe(true);
    expect(message()).toBe('FORM.ISSUE.REQUIRED');
  });

  it('marks every text field touched when it loses the focus', async () => {
    const { host, root, view } = await render();
    for (const field of root.querySelectorAll('input:not([type=checkbox]), textarea')) {
      field.dispatchEvent(new Event('blur'));
    }
    await view();
    const form = host.productForm;
    const touched = [
      form.code,
      form.position,
      form.productionValue,
      form.name['it'],
      form.shortName['en'],
      form.shortDescription['it'],
      form.description['en'],
      form.duration,
      form.maxConcurrent,
      form.modifier.pricePercentagePlus,
      form.modifier.pricePercentageMinus,
      form.modifier.description['it'],
      form.conversionRatio,
      form.plu,
      form.dining.feePercentage,
      form.validFrom,
      form.validTo,
    ].map((field) => field().touched());
    expect(touched.every(Boolean)).toBe(true);
  });

  it('shows the warnings of the code and of the PLU where their fields are', async () => {
    const { host, root, view } = await render();
    expect(root.querySelector('p[role=status]')).toBeNull();
    host.warnings.set([
      { field: 'code', issue: 'duplicate', productIds: ['p1'], others: 0 },
      { field: 'plu', issue: 'duplicate', productIds: ['p2'], others: 0 },
    ]);
    await view();
    const notes = [...root.querySelectorAll('p[role=status]')];
    expect(notes.map((note) => note.querySelector('a')?.textContent)).toEqual(['Pizza', 'Pasta']);
    expect(notes[1].closest('fieldset')?.querySelector('legend')?.textContent?.trim()).toBe('PRODUCTS.CARD.SCALES');
  });

  it('sets the background color from a swatch', async () => {
    const { host, root, view } = await render();
    const swatches = () => [...root.querySelectorAll<HTMLButtonElement>('button.swatch')];
    expect(swatches()).toHaveLength(QUICK_COLORS.length);
    expect(swatches()[1].style.backgroundColor).not.toBe('');
    expect(swatches()[1].getAttribute('aria-label')).toBe(`PRODUCT_CATEGORIES.COLORS.PICK {"color":"${QUICK_COLORS[1]}"}`);
    swatches()[1].click();
    await view();
    expect(host.model().colors.background).toBe(QUICK_COLORS[1]);
    expect(host.model().colors.text).toBe('#000000');
  });

  it('offers no swatches when it is read only', async () => {
    const { host, root, view } = await render();
    host.readOnly.set(true);
    await view();
    expect(root.querySelector('.quick')).toBeNull();
    expect(root.querySelector('button')).toBeNull();
  });
});
