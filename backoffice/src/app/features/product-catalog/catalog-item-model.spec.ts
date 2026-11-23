import { LogoModel } from '../companies/company-model';
import { createBody, ItemModel, logoOf, patchBody, sameIds, toModel } from './catalog-item-model';
import { Brand, CatalogImage, Department } from './product-catalog.types';

const IMAGE: CatalogImage = {
  _id: 'img1',
  basename: 'logo',
  extension: 'png',
  filename: 'logo.png',
  mimetype: 'image/png',
  title: 'Logo',
  alt: 'alt',
  dirname: '/d',
  type: 'image',
  filectime: 5,
};

const DEPARTMENT: Department = {
  id: 'd1',
  name: { it: 'Bibite', en: 'Drinks' },
  description: { it: 'Tutte' },
  enabled: true,
  placeIds: ['p1', 'p2'],
  createdAt: null,
  updatedAt: null,
  code: 12,
  taxId: 't1',
  tax: null,
  noDiscount: false,
  secondaryFiscalPrinter: false,
};

const BRAND: Brand = {
  id: 'b1',
  name: { it: 'Acme' },
  description: {},
  enabled: false,
  placeIds: [],
  image: IMAGE,
  createdAt: null,
  updatedAt: null,
};

const model = (overrides: Partial<ItemModel> = {}): ItemModel => ({
  ...toModel(DEPARTMENT, ['it', 'en']),
  ...overrides,
});
const logo = (imageId: string | null): LogoModel => ({ descriptor: null, imageId, label: 'x', previewUrl: null });

describe('logoOf', () => {
  it('is null without an image', () => {
    expect(logoOf(null)).toBeNull();
    expect(logoOf(undefined)).toBeNull();
  });

  it('keeps the descriptor and labels it with the title', () => {
    expect(logoOf(IMAGE)).toEqual({ descriptor: IMAGE, imageId: null, label: 'Logo', previewUrl: null });
  });

  it('labels with the file name, then the base name, then nothing, and fills the missing parts', () => {
    const empty: CatalogImage = {
      _id: null, basename: null, extension: null, filename: null, mimetype: null,
      title: null, alt: null, dirname: null, type: null, filectime: null,
    };
    expect(logoOf({ ...empty, filename: 'f.png' })?.label).toBe('f.png');
    expect(logoOf({ ...empty, basename: 'f' })?.label).toBe('f');
    expect(logoOf(empty)).toEqual({
      descriptor: {
        _id: '', basename: '', extension: '', filename: '', mimetype: '',
        title: null, alt: null, dirname: '', type: '', filectime: 0,
      },
      imageId: null,
      label: '',
      previewUrl: null,
    });
  });
});

describe('toModel', () => {
  it('has the defaults of a new entry', () => {
    expect(toModel(null, ['it', 'en'])).toEqual({
      enabled: true,
      noDiscount: false,
      secondaryFiscalPrinter: false,
      code: '',
      taxId: '',
      name: { it: '', en: '' },
      description: { it: '', en: '' },
      placeIds: [],
      image: null,
    });
  });

  it('copies a department', () => {
    const result = toModel({ ...DEPARTMENT, noDiscount: true, secondaryFiscalPrinter: true }, ['it', 'en', 'de']);
    expect(result).toMatchObject({
      enabled: true, noDiscount: true, secondaryFiscalPrinter: true, code: '12', taxId: 't1',
      name: { it: 'Bibite', en: 'Drinks', de: '' },
      description: { it: 'Tutte', en: '', de: '' },
      placeIds: ['p1', 'p2'],
      image: null,
    });
    expect(result.placeIds).not.toBe(DEPARTMENT.placeIds);
  });

  it('copies a brand with its image and tolerates a department without code or tax', () => {
    expect(toModel(BRAND, ['it'])).toMatchObject({ enabled: false, code: '', taxId: '', image: { label: 'Logo' } });
    expect(toModel({ ...DEPARTMENT, code: null, taxId: null }, ['it'])).toMatchObject({ code: '', taxId: '' });
  });
});

describe('sameIds', () => {
  it('compares in any order and by length', () => {
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameIds(['a', 'c'], ['a', 'b'])).toBe(false);
  });
});

describe('createBody', () => {
  it('sends the department with everything, trimming the texts and leaving the empty ones out', () => {
    const body = createBody(
      'departments',
      model({ name: { it: ' Bibite ', en: '' }, description: { it: '', en: ' ' }, code: '7', taxId: 't2', noDiscount: true }),
      { media: false },
    );
    expect(body).toEqual({
      name: { it: 'Bibite' },
      enabled: true,
      placeIds: ['p1', 'p2'],
      code: 7,
      taxId: 't2',
      noDiscount: true,
      secondaryFiscalPrinter: false,
    });
  });

  it('sends a description when there is one', () => {
    expect(createBody('brands', model({ description: { it: ' Tutte ', en: '' } }), { media: false })).toEqual({
      name: { it: 'Bibite', en: 'Drinks' },
      description: { it: 'Tutte' },
      enabled: true,
      placeIds: ['p1', 'p2'],
    });
  });

  it('sends the new image only for the groups with media', () => {
    expect(createBody('brands', model({ image: logo('i9') }), { media: true })).toMatchObject({ image: { imageId: 'i9' } });
    expect(createBody('brands', model({ image: logo('i9') }), { media: false })).not.toHaveProperty('image');
    expect(createBody('brands', model({ image: logo(null) }), { media: true })).not.toHaveProperty('image');
    expect(createBody('brands', model({ image: null }), { media: true })).not.toHaveProperty('image');
  });
});

describe('patchBody', () => {
  const same = () => toModel(DEPARTMENT, ['it', 'en']);

  it('is empty when nothing changed, whatever the order of the stores', () => {
    expect(patchBody('departments', same(), DEPARTMENT, { media: true })).toEqual({});
    expect(patchBody('departments', { ...same(), placeIds: ['p2', 'p1'] }, DEPARTMENT, { media: false })).toEqual({});
  });

  it('sends the texts that changed language by language and takes away the emptied ones', () => {
    const changed: ItemModel = {
      ...same(),
      name: { it: ' Bevande ', en: '' },
      description: { it: '', en: 'All' },
    };
    expect(patchBody('brands', changed, DEPARTMENT, { media: false })).toEqual({
      name: { it: 'Bevande', en: null },
      description: { it: null, en: 'All' },
    });
  });

  it('sends the state and the stores that changed', () => {
    expect(patchBody('brands', { ...same(), enabled: false, placeIds: ['p1'] }, DEPARTMENT, { media: false })).toEqual({
      enabled: false,
      placeIds: ['p1'],
    });
  });

  it('sends the fields of the departments that changed, and ignores them for brands', () => {
    const changed = { ...same(), code: '13', taxId: 't9', noDiscount: true, secondaryFiscalPrinter: true };
    expect(patchBody('departments', changed, DEPARTMENT, { media: false })).toEqual({
      code: 13,
      taxId: 't9',
      noDiscount: true,
      secondaryFiscalPrinter: true,
    });
    expect(patchBody('brands', changed, DEPARTMENT, { media: false })).toEqual({});
  });

  it('compares a department without code or tax with the empty form values', () => {
    const bare = { ...DEPARTMENT, code: null, taxId: null };
    expect(patchBody('departments', { ...same(), code: '', taxId: '' }, bare, { media: false })).toEqual({});
  });

  it('takes the image away, replaces it, or leaves it alone, only with media', () => {
    expect(patchBody('brands', { ...toModel(BRAND, ['it']), image: null }, BRAND, { media: true })).toEqual({ image: null });
    expect(patchBody('brands', { ...toModel(BRAND, ['it']), image: null }, BRAND, { media: false })).toEqual({});
    expect(patchBody('brands', { ...toModel(BRAND, ['it']), image: logo('i2') }, BRAND, { media: true })).toEqual({
      image: { imageId: 'i2' },
    });
    expect(patchBody('brands', toModel(BRAND, ['it']), BRAND, { media: true })).toEqual({});
    const noImage = { ...BRAND, image: null };
    expect(patchBody('brands', { ...toModel(noImage, ['it']), image: null }, noImage, { media: true })).toEqual({});
  });
});
