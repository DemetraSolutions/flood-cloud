import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { integrationsConfigOf } from '../../src/composition.ts';
import { testConfig } from '../helpers/app.ts';

describe('integrationsConfigOf', () => {
  it('hands the integrations module its own settings and nothing else of the configuration', () => {
    const config = testConfig();
    const picked = integrationsConfigOf(config);
    assert.deepEqual(Object.keys(picked).sort(), [
      'cervedApiKey', 'cervedBaseUrl', 'dojoApiVersion', 'dojoBaseUrl', 'dojoResellerId', 'dojoSoftwareHouseId', 'geocodingBaseUrl', 'geocodingDailyLimit',
      'googleMapsApiKey', 'satispayAuthBaseUrl', 'satispayPublicKey', 'tshApiBaseUrl', 'tshAuthBaseUrl', 'tshTestApiBaseUrl', 'tshTestAuthBaseUrl',
    ]);
    assert.notEqual(picked, config);
    assert.equal(picked.cervedBaseUrl, config.cervedBaseUrl);
    assert.equal(picked.geocodingDailyLimit, config.geocodingDailyLimit);
  });
});
