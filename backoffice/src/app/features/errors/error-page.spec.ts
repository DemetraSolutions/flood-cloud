import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ErrorPage, requestIdFromState } from './error-page';

async function open(kind: string, state: unknown) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'page', component: ErrorPage, data: { kind } }]),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params ? `${key}:${params['requestId']}` : `[${key}]`,
  );
  vi.spyOn(TestBed.inject(Location), 'getState').mockReturnValue(state);
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl('/page');
  return harness.routeNativeElement as HTMLElement;
}

describe('ErrorPage', () => {
  it.each(['NOT_FOUND', 'FORBIDDEN', 'GENERIC'])(
    'shows the %s texts and a link home',
    async (kind) => {
      const root = await open(kind, null);
      expect(root.querySelector('h1')?.textContent).toBe(`[ERRORS.${kind}.TITLE]`);
      expect(root.querySelector('p')?.textContent).toBe(`[ERRORS.${kind}.MESSAGE]`);
      expect(root.querySelector('a')?.getAttribute('href')).toBe('/');
      expect(root.querySelectorAll('p').length).toBe(2);
    },
  );

  it('shows the request id from the navigation state', async () => {
    const root = await open('GENERIC', { requestId: 'req-42' });
    expect(root.textContent).toContain('ERRORS.REQUEST_ID:req-42');
  });
});

describe('requestIdFromState', () => {
  it('accepts only a string request id', () => {
    expect(requestIdFromState(null)).toBeNull();
    expect(requestIdFromState({})).toBeNull();
    expect(requestIdFromState({ requestId: 1 })).toBeNull();
    expect(requestIdFromState({ requestId: 'abc' })).toBe('abc');
  });
});
