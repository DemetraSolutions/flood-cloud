import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  it('is a busy status region with hidden decorative lines and an announced text', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    vi.spyOn(TestBed.inject(I18nService), 't').mockReturnValue('Caricamento in corso');
    const fixture = TestBed.createComponent(Skeleton);
    fixture.componentRef.setInput('lines', 4);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.querySelector('.visually-hidden')?.textContent).toBe('Caricamento in corso');
    expect(el.querySelectorAll('.line[aria-hidden="true"]').length).toBe(4);
  });

  it('defaults to three lines', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    vi.spyOn(TestBed.inject(I18nService), 't').mockReturnValue('x');
    const fixture = TestBed.createComponent(Skeleton);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.line').length).toBe(3);
  });
});
