import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PageHeader } from './page-header';

@Component({
  imports: [PageHeader],
  template: `
    <fc-page-header heading="Alfa Srl">
      <span class="badge">Sospesa</span>
      <ng-container fcPageActions>
        <a href="/">Indietro</a>
        <button type="submit">Salva</button>
      </ng-container>
    </fc-page-header>
  `,
})
class WithActions {}

@Component({
  imports: [PageHeader],
  template: `<fc-page-header heading="Solo titolo" />`,
})
class TitleOnly {}

describe('PageHeader', () => {
  it('shows the title, the badges after it and the actions at the end, the save last', () => {
    const fixture = TestBed.createComponent(WithActions);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toBe('Alfa Srl');
    const header = root.querySelector('header')!;
    expect([...header.children].map((child) => child.className || child.tagName)).toEqual([
      'H1',
      'badge',
      'page-actions',
    ]);
    const actions = [...root.querySelectorAll('.page-actions > *')].map((n) => n.textContent);
    expect(actions).toEqual(['Indietro', 'Salva']);
  });

  it('has an empty actions area when the page offers none', () => {
    const fixture = TestBed.createComponent(TitleOnly);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toBe('Solo titolo');
    expect(root.querySelector('.page-actions')?.children).toHaveLength(0);
  });
});
