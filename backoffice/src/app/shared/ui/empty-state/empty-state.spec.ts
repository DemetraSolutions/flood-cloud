import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EmptyState } from './empty-state';

@Component({
  imports: [EmptyState],
  template: `<fc-empty-state title="Nessun utente" message="Crea il primo utente"
      ><button type="button">Crea</button></fc-empty-state
    ><fc-empty-state title="Solo titolo" />`,
})
class Host {}

describe('EmptyState', () => {
  it('shows title, optional message and the projected action', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const [full, minimal] = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('fc-empty-state'),
    );
    expect(full.querySelector('.title')?.textContent).toBe('Nessun utente');
    expect(full.querySelector('.message')?.textContent).toBe('Crea il primo utente');
    expect(full.querySelector('button')?.textContent).toBe('Crea');
    expect(minimal.querySelector('.message')).toBeNull();
  });
});
