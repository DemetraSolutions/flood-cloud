import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter, TitleStrategy } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { I18nService } from '../i18n/i18n.service';
import { PageAnnouncer } from './page-announcer';
import { PageTitleStrategy } from './page-title.strategy';

@Component({ template: '' })
class Page {}

describe('PageTitleStrategy', () => {
  async function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'with', title: 'PAGE.KEY', component: Page },
          { path: 'without', component: Page },
        ]),
        { provide: TitleStrategy, useClass: PageTitleStrategy },
      ],
    });
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => `<${key}>`);
    return RouterTestingHarness.create();
  }

  it('translates the route title, sets the document title and announces the page', async () => {
    const harness = await setup();
    await harness.navigateByUrl('/with');
    expect(TestBed.inject(Title).getTitle()).toBe('<PAGE.KEY> · <APP.NAME>');
    expect(TestBed.inject(PageAnnouncer).message()).toBe('<PAGE.KEY>');
  });

  it('falls back to the application name when the route has no title', async () => {
    const harness = await setup();
    await harness.navigateByUrl('/without');
    expect(TestBed.inject(Title).getTitle()).toBe('<APP.NAME>');
    expect(TestBed.inject(PageAnnouncer).message()).toBe('<APP.NAME>');
  });
});
