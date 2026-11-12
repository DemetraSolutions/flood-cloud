import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Textarea } from './textarea';

@Component({
  imports: [Textarea],
  template: `<fc-textarea
    label="Note"
    [rows]="rows()"
    [hint]="hint()"
    [error]="error()"
    required
    [disabled]="disabled()"
    [(value)]="value"
    (blurred)="blurs.set(blurs() + 1)"
  />`,
})
class Host {
  readonly value = signal('ciao');
  readonly rows = signal(4);
  readonly hint = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly disabled = signal(false);
  readonly blurs = signal(0);
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    host: fixture.componentInstance,
    root,
    area: root.querySelector('textarea')!,
  };
}

describe('Textarea', () => {
  it('links a visible label to the textarea', async () => {
    const { root, area } = await render();
    const label = root.querySelector('label')!;
    expect(label.htmlFor).toBe(area.id);
    expect(label.textContent).toBe('Note');
    expect(label.classList.contains('required')).toBe(true);
    expect(area.value).toBe('ciao');
    expect(area.required).toBe(true);
    expect(area.rows).toBe(4);
    expect(area.hasAttribute('aria-invalid')).toBe(false);
    expect(area.hasAttribute('aria-describedby')).toBe(false);
  });

  it('updates the model on input and emits blurred', async () => {
    const { fixture, host, area } = await render();
    area.value = 'nuovo';
    area.dispatchEvent(new Event('input'));
    area.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(host.value()).toBe('nuovo');
    expect(host.blurs()).toBe(1);
  });

  it('sets the number of rows', async () => {
    const { fixture, host, area } = await render();
    host.rows.set(8);
    await fixture.whenStable();
    expect(area.rows).toBe(8);
  });

  it('describes the textarea with hint and error and marks it invalid', async () => {
    const { fixture, host, root, area } = await render();
    host.hint.set('Facoltativo');
    await fixture.whenStable();
    const hint = root.querySelector('.hint')!;
    expect(area.getAttribute('aria-describedby')).toBe(hint.id);

    host.error.set('Troppo lungo');
    await fixture.whenStable();
    const error = root.querySelector('.error')!;
    expect(area.getAttribute('aria-describedby')).toBe(`${hint.id} ${error.id}`);
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect(error.textContent).toContain('Troppo lungo');
    expect(error.querySelector('svg')).not.toBeNull();
  });

  it('can be disabled', async () => {
    const { fixture, host, area } = await render();
    host.disabled.set(true);
    await fixture.whenStable();
    expect(area.disabled).toBe(true);
  });

  it('focuses the textarea when asked to', async () => {
    const { fixture, area } = await render();
    const field = fixture.debugElement.children[0].componentInstance as Textarea;
    field.focus();
    expect(document.activeElement).toBe(area);
  });
});
