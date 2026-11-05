import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { userFailureMessage } from './users-errors';

describe('userFailureMessage', () => {
  it('explains a 403 as a target that cannot be managed, and maps the rest centrally', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const i18n = TestBed.inject(I18nService);
    vi.spyOn(i18n, 't').mockImplementation((key) => `[${key}]`);
    const forbidden = new ApiError({ status: 403, code: 'FORBIDDEN', message: 'm' });
    const conflict = new ApiError({ status: 409, code: 'CONFLICT', message: 'm' });
    expect(userFailureMessage(i18n, forbidden)).toBe('[USERS.FORBIDDEN_TARGET]');
    expect(userFailureMessage(i18n, conflict)).toBe('[ERRORS.API.CONFLICT]');
  });
});
