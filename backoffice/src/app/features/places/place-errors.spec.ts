import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import { fakePlace } from '../../../testing/places';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { placeActionMessage, resolvePlaceField } from './place-errors';
import { toModel } from './place-model';

function apiError(
  status: number,
  code: ApiError['code'],
  details: { field: string; issue: string }[] = [],
) {
  return new ApiError({ status, code, message: code, details });
}

describe('resolvePlaceField', () => {
  const root = TestBed.runInInjectionContext(() => form(signal(toModel(fakePlace()))));

  it('finds the fields of the general tab under general', () => {
    expect(resolvePlaceField(root, 'name')).toBe(root.general.name);
    expect(resolvePlaceField(root, 'address.city')).toBe(root.general.address.city);
    expect(resolvePlaceField(root, 'priceLists.0.ayceCode1')).toBe(
      root.general.priceLists[0].ayceCode1,
    );
  });

  it('finds the license and the rows of the opening hours', () => {
    expect(resolvePlaceField(root, 'license')).toBe(root.license);
    expect(resolvePlaceField(root, 'openingHours.timezone')).toBe(root.openingHours.timezone);
    expect(resolvePlaceField(root, 'openingHours.week.1.values.0.start')).toBe(
      root.openingHours.week['1'].values[0].start,
    );
    expect(resolvePlaceField(root, 'openingHours.special.0.date')).toBe(
      root.openingHours.special[0].date,
    );
  });

  it('finds a scalar key of a block, also when the key has dots', () => {
    expect(resolvePlaceField(root, 'printing.receipt.user')).toBe(root.printing.f['receipt.user']);
    expect(resolvePlaceField(root, 'cashSettings.fastLogin')).toBe(
      root.cashSettings.f['fastLogin'],
    );
    expect(resolvePlaceField(root, 'delivery.takeAway.status')).toBe(
      root.delivery.f['takeAway.status'],
    );
    expect(resolvePlaceField(root, 'media.internalFileName')).toBe(
      root.media.f['internalFileName'],
    );
  });

  it('finds the typed value of a credential, also when the key has dots', () => {
    expect(resolvePlaceField(root, 'integrations.easyappear.appToken')).toBe(
      root.integrations.secrets['easyappear.appToken'].value,
    );
    expect(resolvePlaceField(root, 'integrations.floodPay.stripe.privateKey')).toBe(
      root.integrations.secrets['floodPay.stripe.privateKey'].value,
    );
    expect(resolvePlaceField(root, 'integrations.easyappear.status')).toBe(
      root.integrations.f['easyappear.status'],
    );
    expect(resolvePlaceField(root, 'dealerSettings.serverIp')).toBe(
      root.dealerSettings.f['serverIp'],
    );
  });

  it('finds the rows of the lists of the place', () => {
    expect(resolvePlaceField(root, 'devices.items.0.name')).toBe(root.devices.items[0].name);
    expect(resolvePlaceField(root, 'devices.items.9.name')).toBe(root.devices.items);
    expect(resolvePlaceField(root, 'rooms.items.0.tables.1.name')).toBe(
      root.rooms.items[0].tables[1].name,
    );
    expect(resolvePlaceField(root, 'storages.items.0.name')).toBe(root.storages.items[0].name);
    expect(resolvePlaceField(root, 'printStations.stations.0.host')).toBe(
      root.printStations.stations[0].host,
    );
  });

  it('finds the row of a list, or the list when the row does not exist', () => {
    expect(resolvePlaceField(root, 'payments.paymentTypes.0.name')).toBe(
      root.payments.paymentTypes[0].name,
    );
    expect(resolvePlaceField(root, 'payments.paymentTypes.2.name')).toBe(
      root.payments.paymentTypes,
    );
    expect(resolvePlaceField(root, 'cashSettings.workshiftNames.5')).toBe(
      root.cashSettings.workshiftNames,
    );
  });

  it('finds the image slot of the media block', () => {
    expect(resolvePlaceField(root, 'media.logoLight')).toBe(root.media.logos.logoLight);
    expect(resolvePlaceField(root, 'media.coverKiosk.imageId')).toBe(root.media.logos.coverKiosk);
    expect(resolvePlaceField(root, 'media')).toBe(root.media);
  });

  it('falls back to the block for a name the form does not know', () => {
    expect(resolvePlaceField(root, 'printing.nothing')).toBe(root.printing);
    expect(resolvePlaceField(root, 'kiosk.titleText.fr')).toBe(root.kiosk.titleText);
  });

  it('walks a name that is not a settings block as it is', () => {
    expect(resolvePlaceField(root, 'license.plan')).toBe(root.license.plan);
    expect(resolvePlaceField(root, 'unknown')).toBeUndefined();
    expect(resolvePlaceField(root, 'unknown.field')).toBeUndefined();
  });
});

describe('placeActionMessage', () => {
  const i18n = { t: (key: string) => key } as unknown as I18nService;

  it('has a text for a stale version', () => {
    expect(placeActionMessage(i18n, apiError(412, 'PRECONDITION_FAILED'))).toBe('PLACES.CONFLICT');
  });

  it('has a text for a place still referenced', () => {
    expect(
      placeActionMessage(i18n, apiError(409, 'CONFLICT', [{ field: 'x', issue: 'referenced' }])),
    ).toBe('PLACES.ACTION.ERROR_REFERENCED');
  });

  it('has a text for a company that cannot be used', () => {
    expect(
      placeActionMessage(
        i18n,
        apiError(409, 'CONFLICT', [{ field: 'companyId', issue: 'trashed' }]),
      ),
    ).toBe('PLACES.ACTION.ERROR_COMPANY');
  });

  it('has a generic state text for any other conflict', () => {
    expect(
      placeActionMessage(
        i18n,
        apiError(409, 'CONFLICT', [{ field: 'Idempotency-Key', issue: 'reused' }]),
      ),
    ).toBe('PLACES.ACTION.ERROR_STATE');
    expect(placeActionMessage(i18n, apiError(409, 'CONFLICT'))).toBe('PLACES.ACTION.ERROR_STATE');
  });

  it('uses the central mapping for everything else', () => {
    expect(placeActionMessage(i18n, apiError(403, 'FORBIDDEN'))).toBe('ERRORS.API.FORBIDDEN');
    expect(placeActionMessage(i18n, new Error('x'))).toBeTruthy();
  });
});
