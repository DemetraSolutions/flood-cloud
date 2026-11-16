import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { newPlaceDocument } from '../../src/shared/legacy-write/defaults.ts';
import { fixtureId } from './legacy-fixtures.ts';

/** The price list every place of the first group of the isolation cluster may use. */
export const PRICE_LIST = fixtureId('group', 901).toHexString();

/** The date the fixtures are created. */
export const PLACE_DATE = new Date('2024-01-15T10:00:00.000Z');

/** The one hour slot of the fixtures. */
export const SLOT = { start: '09:00', end: '18:00' };

/** The opening hours of the week of the rich fixture: Monday to Friday open. */
function openWeek(): Document {
  return Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((day) => [day, { active: day !== '0' && day !== '6', values: day !== '0' && day !== '6' ? [{ ...SLOT }] : [] }]));
}

/**
 * A complete place as the old backoffice saves it and as the POS and the legacy have changed it afterwards (`doc/Tasks.md` area 7, analysis of the place): the template of a new place
 * (every block, in the form of `prepareData`) with the exact BSON types the legacy writes (`Int32` and `Double` explicit), the data the POS writes (`devices[i].info`, `rooms[].tables`,
 * `suspendedToday`), integrations with (fake) credentials, the addresses of the store server and the connector, a historical `platform` form, and keys nobody in this backend knows, at the
 * top level and inside the blocks the backend owns. It is the document the "everything that is not ours survives" tests write through.
 *
 * @param n Ordinal of the place (its id is `fixtureId('place', n)`).
 * @param groupId Group of the place.
 * @param companyId Company of the place.
 * @param overrides Fields to add or change.
 */
export function fullLegacyPlace(n: number, groupId: ObjectId, companyId: ObjectId, overrides: Document = {}): Document {
  const base = newPlaceDocument(fixtureId('place', n), groupId, { name: `Bar ${String(n)}`, companyId }, PLACE_DATE);
  const general = base['general'] as Document;
  const roomsSettings = base['roomsSettings'] as Document;
  const block = (name: string, extra: Document): Document => ({ ...(base[name] as Document), ...extra });
  return {
    ...base,
    listId: PRICE_LIST,
    ecommerceListId: null,
    name: 'Bar Roma',
    address: 'Via Roma 1',
    postcode: '20100',
    city: 'Milano',
    countryAreaCode: 'MI',
    countryCode: 'IT',
    contact: 'Mario Rossi',
    email: 'bar@example.test',
    telephone: '+39 02 1234567',
    invoicePS: 'FE',
    medias: { images: { ...(base['medias'] as { images: Document }).images, externalUrl: 'https://example.test/bar.png', unknownImage: 1 } },
    devices: [
      {
        id: 'device1',
        type: 'desk',
        name: 'Cassa',
        host: '10.0.0.5',
        automaticCashUsername: 'fixture-user',
        automaticCashPassword: 'fixture-device-secret',
        info: { appVersion: '1.2.3', date: new Date('2026-01-01T00:00:00.000Z'), battery: new Double(0.5), os: 'x' },
      },
      { id: 'device2', type: 'handheld', name: 'Palmare', info: { appVersion: '1.2.0' } },
    ],
    rooms: [{ id: 'room1', name: 'Sala', tables: [{ id: 't1', name: '1', seats: new Int32(4) }, { id: 't2', name: '2', seats: new Int32(2) }], __index: 0 }],
    storages: [{ id: fixtureId('storage', n), name: 'Deposito 1', cash: true, ecommerce: false }],
    printStations: [{ id: 'ps1', name: 'Cucina', driver: 'epson', host: '10.0.0.6', pulseNumber: new Int32(1) }],
    productionCenter: [{ id: 'pc1', name: 'Forno', capacity: new Int32(5) }],
    openingTime: { weekGeneric: openWeek(), daySpecial: { '2026-12-25': { closed: true, values: [] }, legacyOddKey: { keep: true } }, unknownOpening: 1 },
    timezone: 'Europe/Rome',
    platform: { sentry: true, ip: false },
    server: { ip: '10.0.0.1', port: new Double(8080) },
    connectorAddress: 'http://connector.fixture.example.test',
    general: { ...general, chargeDocumentQt: new Int32(2), totalRounding: new Double(0.05), priceLists: [{ id: PRICE_LIST, allYouCanEat: true, ayceCode1: '12', ayceCode2: null }], unknownGeneral: 'keep' },
    // Keys the backend does not know, or no longer writes, inside the blocks of the settings: they survive every write.
    receipt: block('receipt', { unknownReceipt: 'keep' }),
    ordering: block('ordering', { fontSize: '1-1', sequentialNumber: true }),
    payments: block('payments', { paymentDiscountAuto: false }),
    kiosk: block('kiosk', { unknownKiosk: { keep: [1] } }),
    appointment: block('appointment', { unknownAppointment: 1 }),
    externalDisplay: block('externalDisplay', { unknownDisplay: 1 }),
    tgm: block('tgm', { unknownTgm: 1 }),
    deliveryTakeAway: block('deliveryTakeAway', { unknownTake: 1 }),
    selfOrdering: block('selfOrdering', { unknownSelfOrdering: 1 }),
    paymentTypes: [{ id: 'pt1', name: 'Contanti', cash: true, electronic: false, cheque: false, tickets: false, fattura_elettronica: { ModalitaPagamento: 'MP01' } }],
    roomsSettings: {
      ...roomsSettings,
      exitsNumber: new Int32(5),
      reservation: { ...(roomsSettings['reservation'] as Document), suspendedToday: true, untilHours: '18:00', unknownReservation: 1 },
      tableGroups: { status: false, name: false, autoCreateFirst: false, mergeProductsPrint: true },
    },
    integrations: {
      ...(base['integrations'] as Document),
      dojo: { status: true, apiKey: 'fixture-integration-secret' },
      reserveWithGoogle: {
        status: true,
        category: 'restaurant',
        name: 'Bar Roma',
        telephone: '+39 02 1234567',
        url: null,
        geo: { latitude: new Double(45.46), longitude: new Double(9.19), address: { streetAddress: 'Via Roma 1', locality: 'Milano', postalCode: '20100', country: 'IT' } },
      },
    },
    delivery: { ...(base['delivery'] as Document), minAmount: { EUR: { code: 'EUR', value: new Double(5) } }, unknownDelivery: 1 },
    plan: 'advanced',
    status: true,
    trash: false,
    expirationDate: new Date('2030-01-01T00:00:00.000Z'),
    service: new Int32(0),
    roomsListId: null,
    futureBlock: { nested: [1, 2, 3] },
    ...overrides,
  };
}
