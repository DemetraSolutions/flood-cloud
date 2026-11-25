import { TestBed } from '@angular/core/testing';
import { API, backend, failRequest, provideApiTesting, settle } from '../../../testing/api';
import { signIn } from '../../../testing/session';
import { IntegrationsStatus } from './integrations-status';

const URL = `${API}/v1/integrations`;
const ALL = { cerved: true, dojo: false, satispay: true, tsh: false, geocoding: true };

function setUp(permissions: string[]): IntegrationsStatus {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  signIn({ permissions });
  return TestBed.inject(IntegrationsStatus);
}

afterEach(() => backend().verify());

describe('IntegrationsStatus', () => {
  it('reads nothing until a component asks for it', async () => {
    const status = setUp(['places:read']);
    TestBed.tick();
    await settle();
    expect(status.available('dojo')).toBe(false);
    expect(status.loading()).toBe(false);
    backend().expectNone(URL);
  });

  it('reads the availability once and answers for each provider', async () => {
    const status = setUp(['places:read']);
    status.need();
    status.need();
    TestBed.tick();
    expect(status.loading()).toBe(true);
    expect(status.available('cerved')).toBe(false);
    backend().expectOne(URL).flush({ data: ALL });
    await settle();
    expect(status.loading()).toBe(false);
    expect(status.failed()).toBe(false);
    expect(status.available('cerved')).toBe(true);
    expect(status.available('dojo')).toBe(false);
    expect(status.available('satispay')).toBe(true);
    expect(status.available('tsh')).toBe(false);
    expect(status.available('geocoding')).toBe(true);
  });

  it('reads it also for who can only create groups', async () => {
    const status = setUp(['groups:create']);
    status.need();
    TestBed.tick();
    backend().expectOne(URL).flush({ data: ALL });
    await settle();
    expect(status.available('cerved')).toBe(true);
  });

  it('does not read it for who can do neither', async () => {
    const status = setUp(['profile:read']);
    status.need();
    TestBed.tick();
    await settle();
    backend().expectNone(URL);
    expect(status.available('cerved')).toBe(false);
  });

  it('counts every provider as unavailable when it cannot be read, and does not retry', async () => {
    const status = setUp(['places:read']);
    status.need();
    TestBed.tick();
    failRequest(backend(), '/v1/integrations', 'INTERNAL_ERROR');
    await settle();
    expect(status.failed()).toBe(true);
    expect(status.available('cerved')).toBe(false);
    TestBed.tick();
    backend().expectNone(URL);
  });
});
