import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { TPipe } from './t-pipe';

@Component({
  imports: [TPipe],
  template: `<p>{{ 'COMMON.RETRY' | t }}</p>
    <p>{{ 'GREETING' | t: { name: 'Anna' } }}</p>`,
})
class Host {}

describe('TPipe', () => {
  it('translates keys and parameters and follows the dictionary', async () => {
    const translations = new Map([
      ['COMMON.RETRY', 'Riprova'],
      ['GREETING', 'Ciao {name}'],
    ]);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const service = TestBed.inject(I18nService);
    vi.spyOn(service, 't').mockImplementation((key, params) =>
      (translations.get(key) ?? key).replace('{name}', String(params?.['name'])),
    );
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const paragraphs = (fixture.nativeElement as HTMLElement).querySelectorAll('p');
    expect(paragraphs[0].textContent).toBe('Riprova');
    expect(paragraphs[1].textContent).toBe('Ciao Anna');
  });
});
