import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { GroupChooser } from './group-chooser';

describe('GroupChooser', () => {
  it('asks to choose a group', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
    const fixture = TestBed.createComponent(GroupChooser);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toBe('GROUP_CHOOSER.TITLE');
    expect(root.querySelector('p')?.textContent).toBe('GROUP_CHOOSER.MESSAGE');
  });
});
