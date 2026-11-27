import { fakeApiKey } from '../../../../testing/api-keys';
import {
  buildCreateBody,
  buildPatch,
  expiryIssue,
  limitIssue,
  tooManyIds,
  toKeyModel,
} from './api-key-model';
import { PLATFORM_DEFAULTS, PublicApiSettings } from './api-key.types';

const INHERITED: PublicApiSettings = {
  ...PLATFORM_DEFAULTS,
  defaultRateLimitPerMinute: 30,
  defaultDailyQuota: 500,
};
const NOW = new Date('2026-11-17T12:00:00.000Z');

describe('key model', () => {
  it('starts a new key empty, with the limits it inherits', () => {
    expect(toKeyModel(null, INHERITED)).toEqual({
      name: '',
      permissions: {
        'places:read': false,
        'companies:read': false,
        'catalog:read': false,
        'catalog:write': false,
        'contacts:read': false,
        'contacts:write': false,
        'fidelityCards:read': false,
        'fidelityCards:write': false,
        'sales:read': false,
      },
      companyIds: [],
      placeIds: [],
      expiresOn: '',
      rateLimitPerMinute: '30',
      dailyQuota: '500',
    });
  });

  it('starts from a stored key', () => {
    const key = fakeApiKey({
      permissions: ['catalog:read'],
      restrictions: { companyIds: ['c1'], placeIds: ['p1', 'p2'] },
      expiresAt: '2027-01-02T23:59:59.999Z',
      rateLimitPerMinute: 5,
      dailyQuota: 50,
    });
    expect(toKeyModel(key, INHERITED)).toEqual({
      name: 'Webshop',
      permissions: {
        'places:read': false,
        'companies:read': false,
        'catalog:read': true,
        'catalog:write': false,
        'contacts:read': false,
        'contacts:write': false,
        'fidelityCards:read': false,
        'fidelityCards:write': false,
        'sales:read': false,
      },
      companyIds: ['c1'],
      placeIds: ['p1', 'p2'],
      expiresOn: '2027-01-02',
      rateLimitPerMinute: '5',
      dailyQuota: '50',
    });
  });

  describe('buildCreateBody', () => {
    const model = () => ({
      ...toKeyModel(null, INHERITED),
      name: '  Webshop ',
      permissions: {
        'places:read': true,
        'companies:read': false,
        'catalog:read': true,
        'catalog:write': false,
        'contacts:read': false,
        'contacts:write': false,
        'fidelityCards:read': false,
        'fidelityCards:write': false,
        'sales:read': false,
      },
    });

    it('sends only what was filled in', () => {
      expect(buildCreateBody(model(), INHERITED, true)).toEqual({
        name: 'Webshop',
        permissions: ['places:read', 'catalog:read'],
      });
    });

    it('sends restrictions, expiry and the limits that differ from the inherited ones', () => {
      expect(
        buildCreateBody(
          {
            ...model(),
            companyIds: ['c1'],
            placeIds: ['p1'],
            expiresOn: '2027-01-02',
            rateLimitPerMinute: '10',
            dailyQuota: '900',
          },
          INHERITED,
          true,
        ),
      ).toEqual({
        name: 'Webshop',
        permissions: ['places:read', 'catalog:read'],
        restrictions: { companyIds: ['c1'], placeIds: ['p1'] },
        expiresAt: '2027-01-02T23:59:59.999Z',
        rateLimitPerMinute: 10,
        dailyQuota: 900,
      });
    });

    it('sends one restriction alone', () => {
      expect(
        buildCreateBody({ ...model(), placeIds: ['p1'] }, INHERITED, false).restrictions,
      ).toEqual({
        placeIds: ['p1'],
      });
    });

    it('never sends limits for a user who cannot set them', () => {
      const body = buildCreateBody(
        { ...model(), rateLimitPerMinute: '10', dailyQuota: '900' },
        INHERITED,
        false,
      );
      expect(body).not.toHaveProperty('rateLimitPerMinute');
      expect(body).not.toHaveProperty('dailyQuota');
    });
  });

  describe('buildPatch', () => {
    const key = fakeApiKey({
      restrictions: { companyIds: ['c1', 'c2'], placeIds: null },
      expiresAt: '2027-01-02T23:59:59.999Z',
    });
    const same = () => toKeyModel(key, INHERITED);

    it('is empty when nothing changed (also for the order of the ids)', () => {
      expect(buildPatch(same(), key, true)).toEqual({});
      expect(buildPatch({ ...same(), companyIds: ['c2', 'c1'] }, key, true)).toEqual({});
    });

    it('sends only the changes', () => {
      expect(
        buildPatch(
          {
            ...same(),
            name: 'Nuova',
            permissions: {
              'places:read': true,
              'companies:read': true,
              'catalog:read': true,
              'catalog:write': false,
              'contacts:read': false,
              'contacts:write': false,
              'fidelityCards:read': false,
              'fidelityCards:write': false,
              'sales:read': false,
            },
            companyIds: ['c1'],
            placeIds: ['p9'],
            expiresOn: '2027-02-01',
            rateLimitPerMinute: '61',
            dailyQuota: '10001',
          },
          key,
          true,
        ),
      ).toEqual({
        name: 'Nuova',
        permissions: ['places:read', 'companies:read', 'catalog:read'],
        restrictions: { companyIds: ['c1'], placeIds: ['p9'] },
        expiresAt: '2027-02-01T23:59:59.999Z',
        rateLimitPerMinute: 61,
        dailyQuota: 10001,
      });
    });

    it('removes a restriction and the expiry with null', () => {
      expect(buildPatch({ ...same(), companyIds: [], expiresOn: '' }, key, true)).toEqual({
        restrictions: { companyIds: null },
        expiresAt: null,
      });
    });

    it('removes the restriction on stores with null', () => {
      const withPlaces = fakeApiKey({ restrictions: { companyIds: null, placeIds: ['p1'] } });
      expect(
        buildPatch({ ...toKeyModel(withPlaces, INHERITED), placeIds: [] }, withPlaces, true),
      ).toEqual({
        restrictions: { placeIds: null },
      });
    });

    it('never sends limits for a user who cannot set them', () => {
      expect(
        buildPatch({ ...same(), rateLimitPerMinute: '1', dailyQuota: '1' }, key, false),
      ).toEqual({});
    });
  });

  describe('expiryIssue', () => {
    it.each([
      ['', undefined],
      ['2026-11-17', undefined],
      ['2029-11-16', undefined],
      ['2026-11-16', 'minimum'],
      ['2029-11-17', 'maximum'],
      ['2026-02-30', 'format'],
    ])('judges %s', (day, expected) => {
      expect(expiryIssue(day, NOW)).toBe(expected);
    });
  });

  it('judges the limits with the bounds of the backend', () => {
    expect(limitIssue('6000', 'minute')).toBeUndefined();
    expect(limitIssue('6001', 'minute')).toBe('maximum');
    expect(limitIssue('10000000', 'day')).toBeUndefined();
    expect(limitIssue('10000001', 'day')).toBe('maximum');
    expect(limitIssue('0', 'day')).toBe('minimum');
    expect(limitIssue('1.5', 'day')).toBe('type');
    expect(limitIssue('', 'day')).toBe('required');
  });

  it('allows at most 100 ids in a restriction', () => {
    expect(tooManyIds(Array.from({ length: 100 }, String))).toBe(false);
    expect(tooManyIds(Array.from({ length: 101 }, String))).toBe(true);
  });
});
