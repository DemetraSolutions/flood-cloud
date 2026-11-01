import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IconButton } from './icon-button';

@Component({
  imports: [IconButton],
  template: `<button fc-icon-button icon="menu" label="Apri il menu"></button>`,
})
class Host {}

describe('IconButton', () => {
  it('is a native button named by its label and shows a decorative icon', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Apri il menu');
    expect(button.getAttribute('title')).toBe('Apri il menu');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.textContent?.trim()).toBe('');
  });
});
