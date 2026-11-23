import { LogoModel } from '../companies/company-model';
import { CategoryModel, createBody, patchBody, toModel } from './category-model';
import { CATEGORY_FEATURES, Category, CategoryFeatures } from './category.types';

const LANGUAGES = ['it', 'en'];
const NONE: CategoryFeatures = {
  cash: false,
  customersApp: false,
  tobaccosGamesMonopoly: false,
  productsVariants: false,
  ordering: false,
  rooms: false,
  media: false,
};
const ALL: CategoryFeatures = {
  cash: true,
  customersApp: true,
  tobaccosGamesMonopoly: true,
  productsVariants: true,
  ordering: true,
  rooms: true,
  media: true,
};

const blank = () => toModel(null, LANGUAGES);
const logo = (imageId: string | null): LogoModel => ({
  descriptor: null,
  imageId,
  label: 'logo',
  previewUrl: null,
});

const FULL: Category = {
  id: 'c1',
  parentId: 'p1',
  depth: 1,
  cyclic: false,
  name: { it: 'Pizze', en: 'Pizzas' },
  description: { it: 'Tutte' },
  enabled: false,
  position: 3,
  productionValue: 7,
  availability: { pos: true, ecommerce: true },
  noDiscount: true,
  requiresLegalAge: true,
  secondaryFiscalPrinter: true,
  featured: true,
  integrations: { floodOrders: true, yellgo: true, leggimenu: true },
  dining: {
    endOfMeal: true,
    hiddenOnHandheld: true,
    feePercentage: 12.5,
    printGroup: 2,
    alwaysFirstCourse: true,
    notAffiliatedMenu: true,
    type: 'food',
  },
  tobacco: true,
  backgroundColor: '#ff8064',
  textColor: '#ffffff',
  modifierIds: ['m1'],
  modifierCategoryIds: ['mc1'],
  printStations: { pl1: ['s1', 's2'], pl2: [] },
  counterPrintStations: { pl1: ['s3'] },
  places: [
    { placeId: 'pl1', position: 4, productionCenterId: 'pc1' },
    { placeId: 'pl2', position: null, productionCenterId: null },
  ],
  image: { _id: 'img1', filename: 'a.png' } as Category['image'],
  icon: { _id: 'img2' } as Category['icon'],
  internalFileName: 'file.png',
  externalUrl: 'https://x.test/a.png',
  createdAt: null,
  updatedAt: null,
};

describe('toModel', () => {
  it('has the defaults of a new category, with every language', () => {
    expect(blank()).toEqual({
      enabled: true,
      availability: { pos: false, ecommerce: false },
      noDiscount: false,
      requiresLegalAge: false,
      secondaryFiscalPrinter: false,
      featured: false,
      integrations: { floodOrders: false, yellgo: false, leggimenu: false },
      parentId: '',
      position: '',
      productionValue: '',
      name: { it: '', en: '' },
      description: { it: '', en: '' },
      dining: {
        endOfMeal: false,
        hiddenOnHandheld: false,
        feePercentage: '',
        printGroup: '',
        alwaysFirstCourse: false,
        notAffiliatedMenu: false,
        type: 'other',
      },
      tobacco: false,
      backgroundColor: '#000000',
      textColor: '#000000',
      modifierIds: [],
      modifierCategoryIds: [],
      stations: { rooms: {}, counter: {} },
      places: [],
      image: null,
      icon: null,
      internalFileName: '',
      externalUrl: '',
    });
  });

  it('takes everything from a complete category', () => {
    const model = toModel(FULL, LANGUAGES);
    expect(model).toMatchObject({
      enabled: false,
      availability: { pos: true, ecommerce: true },
      noDiscount: true,
      requiresLegalAge: true,
      secondaryFiscalPrinter: true,
      featured: true,
      integrations: { floodOrders: true, yellgo: true, leggimenu: true },
      parentId: 'p1',
      position: '3',
      productionValue: '7',
      name: { it: 'Pizze', en: 'Pizzas' },
      description: { it: 'Tutte', en: '' },
      dining: {
        endOfMeal: true,
        hiddenOnHandheld: true,
        feePercentage: '12.5',
        printGroup: '2',
        alwaysFirstCourse: true,
        notAffiliatedMenu: true,
        type: 'food',
      },
      tobacco: true,
      backgroundColor: '#ff8064',
      textColor: '#ffffff',
      modifierIds: ['m1'],
      modifierCategoryIds: ['mc1'],
      stations: { rooms: { pl1: ['s1', 's2'] }, counter: { pl1: ['s3'] } },
      places: [
        { placeId: 'pl1', position: '4', productionCenterId: 'pc1' },
        { placeId: 'pl2', position: '', productionCenterId: '' },
      ],
      internalFileName: 'file.png',
      externalUrl: 'https://x.test/a.png',
    });
    expect(model.image?.label).toBeTruthy();
    expect(model.icon).not.toBeNull();
  });

  it('uses the defaults for the optional fields a category lacks', () => {
    const minimal: Category = {
      id: 'c',
      parentId: null,
      depth: null,
      cyclic: false,
      name: {},
      description: {},
      enabled: true,
      position: null,
      productionValue: null,
      noDiscount: false,
      requiresLegalAge: false,
      integrations: { floodOrders: false, yellgo: false, leggimenu: false },
      textColor: null,
      places: [],
      createdAt: null,
      updatedAt: null,
    };
    expect(toModel(minimal, LANGUAGES)).toEqual(blank());
  });
});

describe('createBody', () => {
  const filledModel = (): CategoryModel => ({
    ...toModel(FULL, LANGUAGES),
    image: logo('i1'),
    icon: logo('i2'),
  });

  it('sends the basic fields only for a bare form, without the optional ones', () => {
    expect(createBody(blank(), ALL)).toMatchObject({ enabled: true, noDiscount: false });
    const bare = createBody({ ...blank(), name: { it: '  Pizze ', en: '' } }, NONE);
    expect(bare).toEqual({
      name: { it: 'Pizze' },
      enabled: true,
      noDiscount: false,
      requiresLegalAge: false,
      integrations: { floodOrders: false, yellgo: false, leggimenu: false },
      textColor: '#000000',
    });
  });

  it('sends everything with every feature on', () => {
    expect(createBody(filledModel(), ALL)).toEqual({
      name: { it: 'Pizze', en: 'Pizzas' },
      description: { it: 'Tutte' },
      enabled: false,
      noDiscount: true,
      requiresLegalAge: true,
      integrations: { floodOrders: true, yellgo: true, leggimenu: true },
      textColor: '#ffffff',
      parentId: 'p1',
      position: 3,
      productionValue: 7,
      availability: { pos: true, ecommerce: true },
      featured: true,
      secondaryFiscalPrinter: true,
      tobacco: true,
      dining: {
        endOfMeal: true,
        hiddenOnHandheld: true,
        feePercentage: 12.5,
        printGroup: 2,
        alwaysFirstCourse: true,
        notAffiliatedMenu: true,
        type: 'food',
      },
      backgroundColor: '#ff8064',
      modifierIds: ['m1'],
      modifierCategoryIds: ['mc1'],
      printStations: { pl1: ['s1', 's2'] },
      counterPrintStations: { pl1: ['s3'] },
      places: [
        { placeId: 'pl1', position: 4, productionCenterId: 'pc1' },
        { placeId: 'pl2', position: null, productionCenterId: null },
      ],
      image: { imageId: 'i1' },
      icon: { imageId: 'i2' },
      internalFileName: 'file.png',
      externalUrl: 'https://x.test/a.png',
    });
  });

  it('leaves out every field of a feature that is off', () => {
    const body = createBody(filledModel(), NONE) as Record<string, unknown>;
    for (const key of [
      'availability',
      'featured',
      'secondaryFiscalPrinter',
      'tobacco',
      'dining',
      'backgroundColor',
      'modifierIds',
      'modifierCategoryIds',
      'printStations',
      'counterPrintStations',
      'image',
      'icon',
      'internalFileName',
      'externalUrl',
    ]) {
      expect(body, key).not.toHaveProperty(key);
    }
    expect(body).toHaveProperty('places');
  });

  it.each(CATEGORY_FEATURES)('sends only what the %s feature allows', (feature) => {
    const bare = Object.keys(createBody(filledModel(), NONE));
    const added = Object.keys(createBody(filledModel(), { ...NONE, [feature]: true })).filter(
      (key) => !bare.includes(key),
    );
    const expected: Record<string, string[]> = {
      cash: ['availability', 'backgroundColor'],
      customersApp: ['availability', 'featured'],
      tobaccosGamesMonopoly: ['secondaryFiscalPrinter', 'tobacco'],
      productsVariants: ['modifierIds', 'modifierCategoryIds'],
      ordering: ['printStations', 'counterPrintStations'],
      rooms: ['dining'],
      media: ['image', 'icon', 'internalFileName', 'externalUrl'],
    };
    expect(added.sort()).toEqual(expected[feature].sort());
  });

  it('sends only the availability switch of the feature that is on', () => {
    const model = filledModel();
    expect(createBody(model, { ...NONE, cash: true })).toMatchObject({ availability: { pos: true } });
    expect((createBody(model, { ...NONE, cash: true }) as { availability: object }).availability).toEqual({
      pos: true,
    });
    expect((createBody(model, { ...NONE, customersApp: true }) as { availability: object }).availability).toEqual({
      ecommerce: true,
    });
  });

  it('omits the empty optional values', () => {
    const body = createBody(
      {
        ...blank(),
        name: { it: 'A', en: '' },
        description: { it: ' ', en: '' },
        position: ' ',
        productionValue: '',
        internalFileName: '  ',
        externalUrl: '',
        image: { ...logo(null) },
        icon: null,
      },
      ALL,
    ) as Record<string, unknown>;
    for (const key of ['description', 'parentId', 'position', 'productionValue', 'places', 'image', 'icon', 'internalFileName', 'externalUrl']) {
      expect(body, key).not.toHaveProperty(key);
    }
    expect(body['printStations']).toEqual({});
    expect((body['dining'] as { feePercentage: unknown }).feePercentage).toBeNull();
    expect((body['dining'] as { printGroup: unknown }).printGroup).toBeNull();
  });

  it('does not send an image already stored', () => {
    const stored = { ...logo(null) };
    const body = createBody({ ...blank(), name: { it: 'A', en: '' }, image: stored, icon: stored }, ALL);
    expect(body).not.toHaveProperty('image');
    expect(body).not.toHaveProperty('icon');
  });
});

describe('patchBody', () => {
  const before = () => toModel(FULL, LANGUAGES);
  const patch = (change: (model: CategoryModel) => void, features: CategoryFeatures = ALL) => {
    const model = before();
    change(model);
    return patchBody(model, before(), features);
  };

  it('is empty without differences', () => {
    expect(patchBody(before(), before(), ALL)).toEqual({});
    expect(patchBody(before(), before(), NONE)).toEqual({});
  });

  it('sends the texts language by language, null for a language taken away', () => {
    expect(patch((m) => (m.name = { it: ' Nuove ', en: 'Pizzas' }))).toEqual({ name: { it: 'Nuove' } });
    expect(patch((m) => (m.name = { it: 'Pizze', en: '' }))).toEqual({ name: { en: null } });
    expect(patch((m) => (m.description = { it: '', en: 'New' }))).toEqual({
      description: { it: null, en: 'New' },
    });
  });

  it('sends the simple fields that changed', () => {
    expect(patch((m) => (m.enabled = true))).toEqual({ enabled: true });
    expect(patch((m) => (m.noDiscount = false))).toEqual({ noDiscount: false });
    expect(patch((m) => (m.requiresLegalAge = false))).toEqual({ requiresLegalAge: false });
    expect(patch((m) => (m.textColor = '#000000'))).toEqual({ textColor: '#000000' });
    expect(patch((m) => (m.parentId = 'p2'))).toEqual({ parentId: 'p2' });
    expect(patch((m) => (m.parentId = ''))).toEqual({ parentId: null });
    expect(patch((m) => (m.position = '9'))).toEqual({ position: 9 });
    expect(patch((m) => (m.position = ' '))).toEqual({ position: null });
    expect(patch((m) => (m.productionValue = '1'))).toEqual({ productionValue: 1 });
    expect(patch((m) => (m.productionValue = ''))).toEqual({ productionValue: null });
  });

  it('sends only the integrations that changed', () => {
    expect(
      patch((m) => (m.integrations = { floodOrders: false, yellgo: true, leggimenu: false })),
    ).toEqual({ integrations: { floodOrders: false, leggimenu: false } });
  });

  it('sends only the availability switches the features allow', () => {
    const change = (m: CategoryModel) => (m.availability = { pos: false, ecommerce: false });
    expect(patch(change)).toEqual({ availability: { pos: false, ecommerce: false } });
    expect(patch(change, { ...NONE, cash: true })).toEqual({ availability: { pos: false } });
    expect(patch(change, { ...NONE, customersApp: true })).toEqual({ availability: { ecommerce: false } });
    expect(patch(change, NONE)).toEqual({});
  });

  it('sends the fields of a feature only when the feature is on', () => {
    const change = (m: CategoryModel) => {
      m.featured = false;
      m.secondaryFiscalPrinter = false;
      m.tobacco = false;
      m.backgroundColor = '#111111';
      m.modifierIds = [];
      m.modifierCategoryIds = [];
      m.dining.type = 'beverage';
      m.stations = { ...m.stations, rooms: {} };
      m.image = null;
      m.internalFileName = 'x';
    };
    expect(patch(change, NONE)).toEqual({});
    expect(patch(change, { ...NONE, customersApp: true })).toEqual({ featured: false });
    expect(patch(change, { ...NONE, tobaccosGamesMonopoly: true })).toEqual({
      secondaryFiscalPrinter: false,
      tobacco: false,
    });
    expect(patch(change, { ...NONE, cash: true })).toEqual({ backgroundColor: '#111111' });
    expect(patch(change, { ...NONE, productsVariants: true })).toEqual({
      modifierIds: [],
      modifierCategoryIds: [],
    });
    expect(patch(change, { ...NONE, rooms: true })).toEqual({ dining: { type: 'beverage' } });
    expect(patch(change, { ...NONE, ordering: true })).toEqual({ printStations: { pl1: null } });
    expect(patch(change, { ...NONE, media: true })).toEqual({ image: null, internalFileName: 'x' });
  });

  it('keeps each list unchanged when only the order differs', () => {
    expect(
      patch((m) => {
        m.modifierIds = [...m.modifierIds].reverse();
      }),
    ).toEqual({});
    expect(patch((m) => (m.modifierCategoryIds = ['mc2']))).toEqual({ modifierCategoryIds: ['mc2'] });
    expect(patch((m) => (m.modifierIds = ['m1', 'm2']))).toEqual({ modifierIds: ['m1', 'm2'] });
  });

  it('sends the stations of the stores that changed, null for one left with none', () => {
    expect(
      patch((m) => {
        m.stations = { rooms: { pl1: ['s2', 's1'], pl3: ['s9'] }, counter: {} };
      }),
    ).toEqual({ printStations: { pl3: ['s9'] }, counterPrintStations: { pl1: null } });
    expect(patch((m) => (m.stations = { ...m.stations, rooms: { pl1: ['s1'] } }))).toEqual({ printStations: { pl1: ['s1'] } });
  });

  it('sends the dining keys that changed, with numbers or null', () => {
    expect(
      patch((m) => {
        m.dining.endOfMeal = false;
        m.dining.hiddenOnHandheld = false;
        m.dining.alwaysFirstCourse = false;
        m.dining.notAffiliatedMenu = false;
        m.dining.type = 'other';
        m.dining.feePercentage = '';
        m.dining.printGroup = '5';
      }),
    ).toEqual({
      dining: {
        endOfMeal: false,
        hiddenOnHandheld: false,
        alwaysFirstCourse: false,
        notAffiliatedMenu: false,
        type: 'other',
        feePercentage: null,
        printGroup: 5,
      },
    });
    expect(patch((m) => (m.dining.feePercentage = ' 12.5 '))).toEqual({});
  });

  describe('places', () => {
    it('are left out when only the order differs', () => {
      expect(patch((m) => (m.places = [...m.places].reverse()))).toEqual({});
    });

    it('are sent whole when something changes', () => {
      expect(patch((m) => (m.places[0] = { ...m.places[0], position: '5' }))).toEqual({
        places: [
          { placeId: 'pl1', position: 5, productionCenterId: 'pc1' },
          { placeId: 'pl2', position: null, productionCenterId: null },
        ],
      });
      expect(patch((m) => (m.places[0] = { ...m.places[0], productionCenterId: '' }))).toMatchObject({
        places: [{ productionCenterId: null }, { placeId: 'pl2' }],
      });
    });

    it('are sent as an empty list when removed and as a list when added or sized differently', () => {
      expect(patch((m) => (m.places = []))).toEqual({ places: [] });
      expect(patchBody({ ...blank(), places: [{ placeId: 'x', position: '', productionCenterId: '' }] }, blank(), ALL)).toEqual({
        places: [{ placeId: 'x', position: null, productionCenterId: null }],
      });
    });

    it('ignore spaces around the position', () => {
      expect(patch((m) => (m.places[0] = { ...m.places[0], position: ' 4 ' }))).toEqual({});
    });
  });

  describe('media', () => {
    it('sends null for a removed image or icon, the id for a picked one', () => {
      expect(
        patch((m) => {
          m.image = null;
          m.icon = logo('new');
        }),
      ).toEqual({ image: null, icon: { imageId: 'new' } });
    });

    it('sends nothing for an image already stored or still absent', () => {
      expect(patchBody({ ...before(), image: before().image }, before(), ALL)).toEqual({});
      expect(patchBody({ ...blank(), image: null }, blank(), ALL)).toEqual({});
    });

    it('sends the texts that changed, null when blank', () => {
      expect(
        patch((m) => {
          m.internalFileName = '  ';
          m.externalUrl = ' https://y.test ';
        }),
      ).toEqual({ internalFileName: null, externalUrl: 'https://y.test' });
      expect(patch((m) => (m.externalUrl = ' https://x.test/a.png '))).toEqual({});
    });
  });
});
