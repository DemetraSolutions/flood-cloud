import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createGroupOptionsReader, defaultPriceLists, optionReferenceIssues, referencesGroupLists } from '../../src/modules/users/group-options.ts';
import type { GroupOptionLists } from '../../src/modules/users/group-options.ts';
import { inheritedPos, isPosLimited, posAccessError } from '../../src/modules/users/pos-access.ts';
import type { PosActor } from '../../src/modules/users/pos-access.ts';
import { POS_FLAGS, POS_GRANT_KEYS, POS_LEGACY_KEY, POS_OWNED_FIELDS, defaultPos, emptyPos, offPos } from '../../src/modules/users/pos.catalog.ts';
import type { Pos } from '../../src/modules/users/pos.catalog.ts';
import { applyPosPatch, diffPos, posDocument, posSetPaths, readPos } from '../../src/modules/users/pos.mapper.ts';
import type { UserAnomaly } from '../../src/modules/users/user.types.ts';
import { LEGACY_AUTOMATIC_CASH, LEGACY_BOOLEAN_OPTIONS, LEGACY_SUB_FLAGS, legacyPermissions } from '../helpers/legacy-fixtures.ts';

const read = (permissions: unknown): { pos: Pos; anomalies: UserAnomaly[] } => {
  const anomalies: UserAnomaly[] = [];
  return { pos: readPos(permissions, anomalies), anomalies };
};
const cash = (patch: { status?: unknown; sub?: Record<string, unknown>; options?: Record<string, unknown> }) => legacyPermissions({ cashStatus: patch.status as boolean, sub: patch.sub ?? {}, options: patch.options ?? {} });

describe('the POS catalog', () => {
  it('maps every legacy grant once, typos kept in the document and not in the domain', () => {
    assert.deepEqual(POS_GRANT_KEYS.map(([, legacy]) => legacy).sort(), [...LEGACY_SUB_FLAGS].sort());
    assert.equal(new Set(POS_FLAGS).size, POS_FLAGS.length);
    assert.equal(POS_LEGACY_KEY.printPrebill, 'preblling');
    assert.equal(POS_LEGACY_KEY.roomsOnlyHigherSeatsQuantity, 'roomsOnlyHigherSeatsQunatity');
    assert.equal(POS_LEGACY_KEY.priceChange, 'prices');
    assert.ok(!POS_FLAGS.includes('preblling' as never));
  });

  it('owns exactly the paths of the complete legacy object, one by one', () => {
    const full = legacyPermissions().apps.cash as { sub: Record<string, unknown>; options: Record<string, unknown> };
    const expected = [
      'permissions.apps.cash.status',
      ...Object.keys(full.sub).filter((key) => !['productsStatus', 'automaticCash'].includes(key)).map((key) => `permissions.apps.cash.sub.${key}`),
      ...Object.entries(LEGACY_AUTOMATIC_CASH).flatMap(([device, keys]) => keys.map((key) => `permissions.apps.cash.sub.automaticCash.${device}.${key}`)),
      ...Object.keys(full.options).filter((key) => key !== 'service').map((key) => `permissions.apps.cash.options.${key}`),
      'permissions.apps.cash.options.defaultPriceListId',
    ];
    assert.deepEqual([...POS_OWNED_FIELDS].sort(), expected.sort());
  });

  it('starts every role as the legacy form does', () => {
    for (const role of ['PSA', 'D'] as const) {
      assert.equal(defaultPos(role).enabled, false);
      // Only the two grants that are on when the document has no value for them.
      assert.deepEqual(POS_FLAGS.filter((flag) => defaultPos(role).grants[flag]).sort(), ['cashEnabled', 'handheldEnabled']);
    }
    for (const role of ['SA', 'CA', 'PA', 'E'] as const) {
      const pos = defaultPos(role);
      assert.equal(pos.enabled, true);
      assert.deepEqual(POS_FLAGS.filter((flag) => pos.grants[flag]).sort(), ['cashEnabled', 'discount', 'freeSale', 'handheldEnabled', 'invoices', 'priceChange']);
      assert.equal(pos.grants.handheldWallet, false);
    }
    assert.deepEqual(emptyPos().options.template, 'material-whitepurple-light');
  });
});

describe('readPos', () => {
  it('reads a complete legacy object without remarks', () => {
    const { pos, anomalies } = read(legacyPermissions({ sub: { discount: true, preblling: true, discountMaxPercentage: 20, service: 10, automaticCash: { glory: { withdrawal: true } } }, options: { darkMode: true, favoritesId: 'f1', priceLists: { a: { status: true, selected: true }, b: { status: false, selected: false } } } }));
    assert.deepEqual(anomalies, []);
    assert.equal(pos.enabled, true);
    assert.equal(pos.grants.discount, true);
    assert.equal(pos.grants.printPrebill, true);
    assert.equal(pos.grants.printReceipt, false);
    assert.deepEqual([pos.grants.discountMaxPercentage, pos.grants.servicePercentage, pos.grants.automaticCash.glory.withdrawal, pos.grants.automaticCash.vne.tools], [20, 10, true, false]);
    assert.deepEqual([pos.options.darkMode, pos.options.favoritesId, pos.options.side, pos.options.roomsGridZoomHandheld], [true, 'f1', 'dx', 2]);
    assert.deepEqual(pos.options.priceLists, [{ priceListId: 'a', enabled: true, isDefault: true }, { priceListId: 'b', enabled: false, isDefault: false }]);
    assert.equal(Object.keys(pos.grants).includes('productsStatus'), false);
    assert.equal(LEGACY_BOOLEAN_OPTIONS.every((key) => key in pos.options), true);
  });

  it('reads a missing object as everything off, silently, and a non-object with a remark', () => {
    for (const permissions of [undefined, null, {}, { apps: {} }, { apps: { cash: null } }, 'x']) {
      assert.deepEqual(read(permissions), { pos: emptyPos(), anomalies: [] });
    }
    assert.deepEqual(read({ apps: { cash: 5 } }), { pos: emptyPos(), anomalies: [{ kind: 'invalidType', field: 'permissions.apps.cash' }] });
  });

  it('tolerates the irregular values of production', () => {
    const { pos, anomalies } = read(
      cash({
        sub: { discountMaxPercentage: 33.5, service: null },
        options: { productsFontSize: 'L', productsShortNameFontSize: 'M', roomsTablesColumns: '6', roomsTablesColumnsHandheld: 3, roomsGridZoomHandheld: 1.5, template: null, quickDiscount: 15, defaultPriceListId: 'p1', skipFiscalReceiptTypeRequest: true },
      }),
    );
    assert.deepEqual(anomalies, []);
    assert.deepEqual([pos.grants.discountMaxPercentage, pos.grants.servicePercentage], [33.5, null]);
    assert.deepEqual([pos.options.productsFontSize, pos.options.productsShortNameFontSize, pos.options.roomsTablesColumns, pos.options.roomsTablesColumnsHandheld, pos.options.roomsGridZoomHandheld], ['l', 'm', 6, 3, 1.5]);
    assert.deepEqual([pos.options.template, pos.options.quickDiscount, pos.options.defaultPriceListId, pos.options.skipFiscalReceiptTypeRequest], [null, 15, 'p1', true]);
  });

  it('reads a value that is wrong as the default and says so', () => {
    const { pos, anomalies } = read(
      cash({
        status: 'yes',
        sub: { discount: 'yes', discountMaxPercentage: 150, service: '10', automaticCash: { glory: { deposit: 1 } } },
        options: { side: 'up', virtualKeyboard: 'x', template: 'neon', productsFontSize: 'xl', roomsTablesColumns: 7, roomsTablesColumnsHandheld: 'many', roomsGridZoomHandheld: 9, favoritesId: 5, defaultPriceListId: '', quickDiscount: -1, darkMode: 'no', priceLists: [] },
      }),
    );
    assert.equal(pos.enabled, false);
    assert.equal(pos.grants.discount, false);
    assert.equal(pos.grants.discountMaxPercentage, null);
    assert.equal(pos.grants.servicePercentage, null);
    assert.equal(pos.grants.automaticCash.glory.deposit, false);
    assert.deepEqual([pos.options.side, pos.options.virtualKeyboard, pos.options.template, pos.options.productsFontSize, pos.options.roomsTablesColumns, pos.options.roomsTablesColumnsHandheld, pos.options.roomsGridZoomHandheld, pos.options.favoritesId, pos.options.defaultPriceListId, pos.options.quickDiscount, pos.options.darkMode], ['dx', '', null, 's', null, null, 2, null, null, null, false]);
    assert.deepEqual(pos.options.priceLists, []);
    assert.equal(anomalies.length, 17);
    assert.ok(anomalies.every((anomaly) => anomaly.kind === 'invalidType' && anomaly.field!.startsWith('permissions.apps.cash.')));
  });

  it('reads the price lists defensively', () => {
    assert.deepEqual(read(cash({ options: { priceLists: 'x' } })).anomalies, [{ kind: 'invalidType', field: 'permissions.apps.cash.options.priceLists' }]);
    assert.deepEqual(read(cash({ options: { priceLists: null } })).anomalies, []);
    const { pos, anomalies } = read(cash({ options: { priceLists: { a: { status: true }, b: 'x', c: { selected: true } } } }));
    assert.deepEqual(pos.options.priceLists, [{ priceListId: 'a', enabled: true, isDefault: false }, { priceListId: 'c', enabled: false, isDefault: true }]);
    assert.deepEqual(anomalies, [{ kind: 'invalidType', field: 'permissions.apps.cash.options.priceLists.b' }]);
    const many = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`l${String(index)}`, { status: true, selected: false }]));
    const big = read(cash({ options: { priceLists: many } }));
    assert.equal(big.pos.options.priceLists.length, 200);
    assert.equal(big.anomalies.length, 1);
  });
});

describe('POS patches', () => {
  const base = defaultPos('SA');

  it('applies only the values the patch carries, with the automatic cash devices merged', () => {
    assert.deepEqual(applyPosPatch(base, undefined), base);
    const next = applyPosPatch(base, { enabled: false, grants: { discount: false, rider: true, discountMaxPercentage: 10, automaticCash: { glory: { deposit: true } } }, options: { darkMode: true, template: null, priceLists: [{ priceListId: 'a', enabled: true, isDefault: true }] } });
    assert.deepEqual([next.enabled, next.grants.discount, next.grants.rider, next.grants.freeSale, next.grants.discountMaxPercentage], [false, false, true, true, 10]);
    assert.deepEqual([next.grants.automaticCash.glory.deposit, next.grants.automaticCash.glory.withdrawal, next.grants.automaticCash.vne.tools], [true, false, false]);
    assert.deepEqual([next.options.darkMode, next.options.template, next.options.side, next.options.priceLists.length], [true, null, 'dx', 1]);
    // `undefined` means "not sent".
    assert.deepEqual(applyPosPatch(base, { enabled: undefined, grants: { discount: undefined }, options: { darkMode: undefined } }), base);
  });

  it('diffs two states into a minimal patch, and nothing when they are the same', () => {
    assert.equal(diffPos(base, applyPosPatch(base, {})), undefined);
    const next = applyPosPatch(base, { enabled: false, grants: { rider: true, servicePercentage: 5, automaticCash: { cashSystem: { withdrawal: true }, vne: { tools: true } } }, options: { darkMode: true, priceLists: [{ priceListId: 'a', enabled: true, isDefault: false }] } });
    assert.deepEqual(diffPos(base, next), {
      enabled: false,
      grants: { rider: true, servicePercentage: 5, automaticCash: { vne: { tools: true }, cashSystem: { withdrawal: true } } },
      options: { darkMode: true, priceLists: [{ priceListId: 'a', enabled: true, isDefault: false }] },
    });
    assert.deepEqual(diffPos(base, applyPosPatch(base, { options: { darkMode: true } })), { options: { darkMode: true } });
  });

  it('writes one path per value, with the legacy names, and the price lists as a map', () => {
    assert.deepEqual(posSetPaths({}), {});
    assert.deepEqual(
      posSetPaths({
        enabled: true,
        grants: { printPrebill: true, priceChange: false, roomsOnlyHigherSeatsQuantity: true, discountMaxPercentage: null, servicePercentage: 7, automaticCash: { azkoyen: { status: true } }, rider: undefined },
        options: { darkMode: true, favoritesId: null, priceLists: [{ priceListId: 'a', enabled: true, isDefault: true }] },
      }),
      {
        'permissions.apps.cash.status': true,
        'permissions.apps.cash.sub.preblling': true,
        'permissions.apps.cash.sub.prices': false,
        'permissions.apps.cash.sub.roomsOnlyHigherSeatsQunatity': true,
        'permissions.apps.cash.sub.discountMaxPercentage': null,
        'permissions.apps.cash.sub.service': 7,
        'permissions.apps.cash.sub.automaticCash.azkoyen.status': true,
        'permissions.apps.cash.options.darkMode': true,
        'permissions.apps.cash.options.favoritesId': null,
        'permissions.apps.cash.options.priceLists': { a: { status: true, selected: true } },
      },
    );
    for (const path of Object.keys(posSetPaths({ grants: Object.fromEntries(POS_FLAGS.map((flag) => [flag, true])) }))) {
      assert.ok(POS_OWNED_FIELDS.includes(path), path);
    }
  });

  it('builds the complete legacy object of a new user', () => {
    const document = posDocument(applyPosPatch(defaultPos('CA'), { options: { priceLists: [{ priceListId: 'a', enabled: true, isDefault: true }], defaultPriceListId: 'a' } }));
    const expected = legacyPermissions({ options: { priceLists: { a: { status: true, selected: true } }, defaultPriceListId: 'a' }, sub: { discount: true, prices: true, invoices: true, freeSale: true } }).apps.cash as Record<string, Record<string, unknown>>;
    delete expected['sub']!['productsStatus'];
    delete expected['options']!['service'];
    assert.deepEqual(document, expected);
    assert.equal('defaultPriceListId' in (posDocument(emptyPos())['options'] as object), false);
    assert.deepEqual(read({ apps: { cash: document } }).anomalies, []);
  });
});

const pos = (role: Parameters<typeof defaultPos>[0], patch: Parameters<typeof applyPosPatch>[1] = {}): Pos => applyPosPatch(defaultPos(role), patch);
const actorOf = (role: PosActor['role'], own: Pos, canManagePermissions = true): PosActor => ({ role, canManagePermissions, pos: () => Promise.resolve(own) });
const refused = (error: Awaited<ReturnType<typeof posAccessError>>) => (error === null ? null : [error.code, error.details?.map((detail) => `${detail.field}:${detail.issue}`)]);

describe('who may give which POS permission', () => {
  it('limits only the CA and the PA', () => {
    assert.deepEqual((['PSA', 'D', 'SA', 'CA', 'PA', 'E'] as const).map(isPosLimited), [false, false, false, true, true, false]);
  });

  it('starts a new user from the default of the role, limited to what a CA or PA creator holds', () => {
    assert.deepEqual(inheritedPos(null, 'PA'), defaultPos('PA'));
    const holder = pos('CA', { grants: { freeSale: false, discountMaxPercentage: 30 } });
    const given = inheritedPos(holder, 'PA');
    assert.deepEqual(POS_FLAGS.filter((flag) => given.grants[flag]).sort(), ['cashEnabled', 'discount', 'handheldEnabled', 'invoices', 'priceChange']);
    // A creator who does not hold the grants that are on by default does not give them either.
    const without = pos('CA', { grants: { cashEnabled: false, handheldEnabled: false } });
    assert.deepEqual(POS_FLAGS.filter((flag) => inheritedPos(without, 'PA').grants[flag]).sort(), ['discount', 'freeSale', 'invoices', 'priceChange']);
    assert.deepEqual([given.enabled, given.grants.discountMaxPercentage], [true, 30]);
    assert.equal(inheritedPos(applyPosPatch(holder, { enabled: false }), 'PA').enabled, false);
    assert.equal(inheritedPos(holder, 'D').enabled, false);
  });

  it('allows what changes no permission, with or without canManagePermissions', async () => {
    const before = pos('PA');
    const options = applyPosPatch(before, { options: { darkMode: true } });
    assert.equal(await posAccessError(actorOf('PA', pos('PA'), false), 'PA', before, options), null);
    assert.equal(await posAccessError(actorOf('SA', emptyPos(), false), 'E', null, defaultPos('E')), null);
    // A creation by someone who holds less gets the limited default, and that is allowed.
    const limited = pos('CA', { grants: { discount: false } });
    assert.equal(await posAccessError(actorOf('CA', limited, false), 'PA', null, inheritedPos(limited, 'PA')), null);
  });

  it('refuses a change of permissions to someone who cannot manage them, without details', async () => {
    const before = pos('PA');
    assert.deepEqual(refused(await posAccessError(actorOf('SA', emptyPos(), false), 'PA', before, applyPosPatch(before, { grants: { rider: true } }))), ['FORBIDDEN', undefined]);
    assert.deepEqual(refused(await posAccessError(actorOf('SA', emptyPos(), false), 'PA', null, applyPosPatch(defaultPos('PA'), { enabled: false }))), ['FORBIDDEN', undefined]);
  });

  it('lets PSA, D and SA give any permission', async () => {
    const before = pos('PA');
    const everything = applyPosPatch(before, { enabled: false, grants: { rider: true, discountMaxPercentage: 100, automaticCash: { glory: { deposit: true } } } });
    for (const role of ['PSA', 'D', 'SA'] as const) {
      assert.equal(await posAccessError(actorOf(role, emptyPos()), 'PA', before, everything), null, role);
      assert.equal(await posAccessError(actorOf(role, emptyPos()), 'PA', null, everything), null, role);
    }
  });

  it('lets a CA or PA give only the flags, the automatic cash, the app and the cap he holds', async () => {
    const holder = pos('CA', { grants: { rider: true, discountMaxPercentage: 20, automaticCash: { glory: { deposit: true } } } });
    const before = pos('PA');
    for (const role of ['CA', 'PA'] as const) {
      const actor = actorOf(role, holder);
      assert.equal(await posAccessError(actor, 'PA', before, applyPosPatch(before, { grants: { rider: true, discountMaxPercentage: 20, automaticCash: { glory: { deposit: true } } } })), null);
      assert.equal(await posAccessError(actor, 'PA', before, applyPosPatch(before, { grants: { rider: false, discountMaxPercentage: 5 } })), null, 'turning off or lowering is free');
      assert.deepEqual(
        refused(await posAccessError(actor, 'PA', before, applyPosPatch(before, { grants: { tableMerge: true, automaticCash: { vne: { tools: true } } } }))),
        ['FORBIDDEN', ['pos.grants.tableMerge:notAllowed', 'pos.grants.automaticCash.vne.tools:notAllowed']],
      );
      assert.deepEqual(refused(await posAccessError(actor, 'PA', before, applyPosPatch(before, { grants: { discountMaxPercentage: 21 } }))), ['FORBIDDEN', ['pos.grants.discountMaxPercentage:notAllowed']]);
      const capped = pos('PA', { grants: { discountMaxPercentage: 10 } });
      assert.deepEqual(refused(await posAccessError(actor, 'PA', capped, applyPosPatch(capped, { grants: { discountMaxPercentage: null } }))), ['FORBIDDEN', ['pos.grants.discountMaxPercentage:notAllowed']]);
    }
    const off = actorOf('PA', applyPosPatch(holder, { enabled: false }));
    const disabled = applyPosPatch(before, { enabled: false });
    assert.deepEqual(refused(await posAccessError(off, 'PA', disabled, applyPosPatch(disabled, { enabled: true }))), ['FORBIDDEN', ['pos.enabled:notAllowed']]);
  });

  it('does not stop a CA without a cap, and leaves a cap alone when the request does not change it', async () => {
    const noCap = actorOf('CA', pos('CA', { grants: { rider: true } }));
    const before = pos('PA');
    assert.equal(await posAccessError(noCap, 'PA', before, applyPosPatch(before, { grants: { rider: true, discountMaxPercentage: 90 } })), null);
    const capped = actorOf('CA', pos('CA', { grants: { rider: true, discountMaxPercentage: 20 } }));
    const high = pos('PA', { grants: { discountMaxPercentage: 80 } });
    assert.equal(await posAccessError(capped, 'PA', high, applyPosPatch(high, { grants: { rider: true } })), null);
  });

  it('lets a manager who holds less switch everything off, which is a change from the default but gives nothing', async () => {
    const holder = pos('CA', { grants: { rider: true } });
    assert.equal(await posAccessError(actorOf('CA', holder), 'PA', null, emptyPos()), null);
    // Even the grants that are on by default: a creation that turns everything off is a change from the default, and gives nothing.
    assert.equal(await posAccessError(actorOf('CA', holder), 'PA', null, offPos()), null);
  });

  it('checks a creation from nothing: the default flags and the ones the request adds', async () => {
    const holder = pos('CA', { grants: { freeSale: false, discountMaxPercentage: 20 } });
    const actor = actorOf('CA', holder);
    const started = inheritedPos(holder, 'PA');
    assert.equal(await posAccessError(actor, 'PA', null, started), null);
    // Setting a flag the creator lacks, even one the role has by default, is refused.
    assert.deepEqual(refused(await posAccessError(actor, 'PA', null, applyPosPatch(started, { grants: { freeSale: true } }))), ['FORBIDDEN', ['pos.grants.freeSale:notAllowed']]);
    // The cap is checked on a creation too: null (none) and a higher value are refused.
    assert.deepEqual(refused(await posAccessError(actor, 'PA', null, applyPosPatch(started, { grants: { discountMaxPercentage: null } }))), ['FORBIDDEN', ['pos.grants.discountMaxPercentage:notAllowed']]);
    assert.deepEqual(refused(await posAccessError(actor, 'PA', null, applyPosPatch(started, { grants: { discountMaxPercentage: 25 } }))), ['FORBIDDEN', ['pos.grants.discountMaxPercentage:notAllowed']]);
    assert.equal(await posAccessError(actor, 'PA', null, applyPosPatch(started, { grants: { discountMaxPercentage: 10 } })), null);
    // A request that clears everything is a change from the default, allowed to a manager.
    assert.equal(await posAccessError(actor, 'PA', null, applyPosPatch(started, { enabled: false, grants: { discount: false, priceChange: false, invoices: false } })), null);
  });
});

describe('the grants and the preferences of the handheld 2.0', () => {
  it('reads the cash and handheld switches as on when the document has none, off only when it says false', () => {
    const missing = read(cash({ sub: {} })).pos.grants;
    assert.deepEqual([missing.cashEnabled, missing.handheldEnabled, missing.handheldWallet], [true, true, false]);
    const absent = readPos({ apps: { cash: { status: true, sub: {}, options: {} } } }, []).grants;
    assert.deepEqual([absent.cashEnabled, absent.handheldEnabled, absent.handheldWallet], [true, true, false]);
    const off = read(cash({ sub: { cashEnabled: false, handheldEnabled: false, handheldWallet: true } }));
    assert.deepEqual([off.pos.grants.cashEnabled, off.pos.grants.handheldEnabled, off.pos.grants.handheldWallet, off.anomalies], [false, false, true, []]);
    const junk = read(cash({ sub: { cashEnabled: 'no', handheldEnabled: null, handheldWallet: 1 } }));
    assert.deepEqual([junk.pos.grants.cashEnabled, junk.pos.grants.handheldEnabled, junk.pos.grants.handheldWallet], [true, true, false]);
    assert.deepEqual(junk.anomalies.map((anomaly) => anomaly.field), ['permissions.apps.cash.sub.cashEnabled', 'permissions.apps.cash.sub.handheldWallet']);
  });

  it('reads the preferences with the legacy defaults when absent or wrong', () => {
    const none = read(cash({ options: { productsColorStyle: undefined, handheldTextZoom: undefined } }));
    assert.deepEqual(
      [none.pos.options.productsColorStyle, none.pos.options.productsUppercase, none.pos.options.productsBold, none.pos.options.roomsLegend, none.pos.options.handheldTextZoom, none.pos.options.handheldCategoriesLayout, none.pos.options.handheldCategoriesRows, none.pos.options.handheldProductsColumns, none.pos.options.handheldMenuPosition],
      ['line', false, false, false, 100, 'scroll', 2, 2, 'bottom'],
    );
    const set = read(cash({ options: { productsColorStyle: 'fill', productsUppercase: true, productsBold: true, roomsLegend: true, handheldTextZoom: 85, handheldCategoriesLayout: 'list', handheldCategoriesRows: 1, handheldProductsColumns: 4, handheldMenuPosition: 'top' } }));
    assert.deepEqual(set.anomalies, []);
    assert.deepEqual(
      [set.pos.options.productsColorStyle, set.pos.options.productsUppercase, set.pos.options.productsBold, set.pos.options.roomsLegend, set.pos.options.handheldTextZoom, set.pos.options.handheldCategoriesLayout, set.pos.options.handheldCategoriesRows, set.pos.options.handheldProductsColumns, set.pos.options.handheldMenuPosition],
      ['fill', true, true, true, 85, 'list', 1, 4, 'top'],
    );
    const junk = read(cash({ options: { productsColorStyle: 'x', handheldTextZoom: 87, handheldCategoriesLayout: 'grid', handheldCategoriesRows: 3, handheldProductsColumns: '2', handheldMenuPosition: 'left', roomsLegend: 'yes' } }));
    assert.deepEqual(
      [junk.pos.options.productsColorStyle, junk.pos.options.handheldTextZoom, junk.pos.options.handheldCategoriesLayout, junk.pos.options.handheldCategoriesRows, junk.pos.options.handheldProductsColumns, junk.pos.options.handheldMenuPosition, junk.pos.options.roomsLegend],
      ['line', 100, 'scroll', 2, 2, 'bottom', false],
    );
    assert.equal(junk.anomalies.length, 7);
  });

  it('writes them on their legacy paths, as numbers and texts, and keeps the keys it does not own', () => {
    const base = defaultPos('SA');
    const next = applyPosPatch(base, { grants: { cashEnabled: false, handheldWallet: true }, options: { handheldTextZoom: 115, productsColorStyle: 'fill', roomsLegend: true } });
    assert.deepEqual(posSetPaths(diffPos(base, next)!), {
      'permissions.apps.cash.sub.cashEnabled': false,
      'permissions.apps.cash.sub.handheldWallet': true,
      'permissions.apps.cash.options.productsColorStyle': 'fill',
      'permissions.apps.cash.options.handheldTextZoom': 115,
      'permissions.apps.cash.options.roomsLegend': true,
    });
    const document = posDocument(defaultPos('E')) as { sub: Record<string, unknown>; options: Record<string, unknown> };
    assert.deepEqual([document.sub['cashEnabled'], document.sub['handheldEnabled'], document.sub['handheldWallet']], [true, true, false]);
    assert.deepEqual(
      [document.options['productsColorStyle'], document.options['productsUppercase'], document.options['productsBold'], document.options['roomsLegend'], document.options['handheldTextZoom'], document.options['handheldCategoriesLayout'], document.options['handheldCategoriesRows'], document.options['handheldProductsColumns'], document.options['handheldMenuPosition']],
      ['line', false, false, false, 100, 'scroll', 2, 2, 'bottom'],
    );
  });

  it('owns the new paths', () => {
    for (const key of ['sub.cashEnabled', 'sub.handheldEnabled', 'sub.handheldWallet', 'options.productsColorStyle', 'options.productsUppercase', 'options.productsBold', 'options.roomsLegend', 'options.handheldTextZoom', 'options.handheldCategoriesLayout', 'options.handheldCategoriesRows', 'options.handheldProductsColumns', 'options.handheldMenuPosition']) {
      assert.ok(POS_OWNED_FIELDS.includes(`permissions.apps.cash.${key}`), key);
    }
  });

  it('judges the new grants like the others: a limited creator cannot give what he does not hold, even from the default', async () => {
    const holder = pos('CA', { grants: { cashEnabled: false } });
    const actor = actorOf('CA', holder);
    const before = pos('PA', { grants: { cashEnabled: false } });
    assert.deepEqual(refused(await posAccessError(actor, 'PA', before, applyPosPatch(before, { grants: { cashEnabled: true, handheldWallet: true } }))), ['FORBIDDEN', ['pos.grants.cashEnabled:notAllowed', 'pos.grants.handheldWallet:notAllowed']]);
    // A creation: the switch the default has on, and a request that sets it on, are judged against what the creator holds.
    const started = inheritedPos(holder, 'PA');
    assert.equal(started.grants.cashEnabled, false);
    assert.equal(await posAccessError(actor, 'PA', null, started), null);
    assert.deepEqual(refused(await posAccessError(actor, 'PA', null, applyPosPatch(started, { grants: { cashEnabled: true } }))), ['FORBIDDEN', ['pos.grants.cashEnabled:notAllowed']]);
    // Whoever cannot manage permissions cannot change them; the preferences stay free.
    assert.deepEqual(refused(await posAccessError(actorOf('SA', emptyPos(), false), 'PA', before, applyPosPatch(before, { grants: { handheldEnabled: false } }))), ['FORBIDDEN', undefined]);
    assert.equal(await posAccessError(actorOf('SA', emptyPos(), false), 'PA', before, applyPosPatch(before, { options: { handheldTextZoom: 120, productsColorStyle: 'fill' } })), null);
  });
});

describe('the lists a user\'s POS options refer to', () => {
  const group: GroupOptionLists = {
    priceLists: [
      { id: 'a', name: 'A', enabled: true, isDefault: true },
      { id: 'b', name: 'B', enabled: false, isDefault: false },
    ],
    favoriteIds: new Set(['f1']),
  };
  const list = (priceListId: string, isDefault = false) => ({ priceListId, enabled: true, isDefault });

  it('reads them through the catalogs of the group', async () => {
    const stored = { priceLists: { a: { id: 'a', name: 'A', status: true, default: true } }, productsFavorites: [{ id: 'f1', name: 'F', favorites: [{ _id: new ObjectId() }] }] };
    const reader = createGroupOptionsReader({ read: (_id, paths) => Promise.resolve({ updateDate: undefined, size: 0, values: Object.fromEntries(paths.map((path) => [path, (stored as Record<string, unknown>)[path]])) }) });
    const found = await reader.read(new ObjectId());
    assert.deepEqual([found?.priceLists.map((entry) => entry.id), [...found!.favoriteIds]], [['a'], ['f1']]);
    assert.equal(await createGroupOptionsReader({ read: () => Promise.resolve(null) }).read(new ObjectId()), null);
  });

  it('starts a new user with every price list of the group enabled and the default of the group selected', () => {
    assert.deepEqual(defaultPriceLists(group), [list('a', true), list('b')]);
    assert.deepEqual(defaultPriceLists(null), []);
  });

  it('knows when the group has to be read', () => {
    assert.deepEqual([undefined, {}, { darkMode: true }, { favoritesId: null }, { defaultPriceListId: null }].map(referencesGroupLists), [false, false, false, false, false]);
    assert.deepEqual([{ priceLists: [] }, { favoritesId: 'f1' }, { defaultPriceListId: 'a' }].map(referencesGroupLists), [true, true, true]);
  });

  it('accepts what exists in the group and refuses the rest, field by field', () => {
    assert.deepEqual(optionReferenceIssues(undefined, null, group), []);
    assert.deepEqual(optionReferenceIssues({ priceLists: [list('a', true), list('b')], favoritesId: 'f1', defaultPriceListId: 'b' }, null, group), []);
    assert.deepEqual(optionReferenceIssues({ priceLists: [list('x'), list('a', true), list('a', true), list('b', true)], favoritesId: 'nope', defaultPriceListId: 'zzz' }, null, group), [
      { field: 'pos.options.priceLists.0.priceListId', issue: 'incorrect' },
      { field: 'pos.options.priceLists.2.priceListId', issue: 'incorrect' },
      { field: 'pos.options.priceLists.2.isDefault', issue: 'incorrect' },
      { field: 'pos.options.priceLists.3.isDefault', issue: 'incorrect' },
      { field: 'pos.options.favoritesId', issue: 'incorrect' },
      { field: 'pos.options.defaultPriceListId', issue: 'incorrect' },
    ]);
  });

  it('does not check again what the user already has, and refuses everything for a user without a group', () => {
    const before = { ...defaultPos('SA').options, priceLists: [list('gone')], favoritesId: 'old', defaultPriceListId: 'old' };
    assert.deepEqual(optionReferenceIssues({ priceLists: [list('gone'), list('a')], favoritesId: 'old', defaultPriceListId: 'old' }, before, group), []);
    assert.deepEqual(optionReferenceIssues({ priceLists: [list('a')], favoritesId: 'f1', defaultPriceListId: 'a' }, null, null, 'x'), [
      { field: 'x.priceLists.0.priceListId', issue: 'incorrect' },
      { field: 'x.favoritesId', issue: 'incorrect' },
      { field: 'x.defaultPriceListId', issue: 'incorrect' },
    ]);
    assert.deepEqual(optionReferenceIssues({ priceLists: [], favoritesId: null, defaultPriceListId: null }, null, null), []);
  });
});
