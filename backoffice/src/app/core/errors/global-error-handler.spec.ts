import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { I18nService } from '../i18n/i18n.service';
import { GlobalErrorHandler } from './global-error-handler';

describe('GlobalErrorHandler', () => {
  it('logs the error and shows a generic toast without technical details', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ErrorHandler, useClass: GlobalErrorHandler },
      ],
    });
    vi.spyOn(TestBed.inject(I18nService), 't').mockReturnValue('Qualcosa è andato storto');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('boom: db password');
    TestBed.inject(ErrorHandler).handleError(error);
    expect(log).toHaveBeenCalledWith(error);
    const toasts = TestBed.inject(ToastService).toasts();
    expect(toasts.length).toBe(1);
    expect(toasts[0].kind).toBe('error');
    expect(toasts[0].message).toBe('Qualcosa è andato storto');
    vi.restoreAllMocks();
  });
});
