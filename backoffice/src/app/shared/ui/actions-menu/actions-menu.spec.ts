import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActionsMenu } from './actions-menu';

@Component({
  imports: [ActionsMenu],
  template: `<fc-actions-menu text="Azioni" label="Azioni per mario"
      ><button id="one" (click)="clicks = clicks + 1">Uno</button
      ><button id="two">Due</button></fc-actions-menu
    ><button id="outside">Fuori</button>`,
})
class Host {
  clicks = 0;
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const trigger = root.querySelector<HTMLButtonElement>('.trigger')!;
  const panel = root.querySelector<HTMLElement>('.panel')!;
  const settle = () => fixture.whenStable();
  return { fixture, root, trigger, panel, settle };
}

afterEach(() => document.body.replaceChildren());

describe('ActionsMenu', () => {
  it('is a closed disclosure named after the row', async () => {
    const { trigger, panel } = await render();
    expect(trigger.getAttribute('title')).toBe('Azioni');
    expect(trigger.querySelector('svg')).not.toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe('Azioni per mario');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.hidden).toBe(true);
  });

  it('opens under the button and closes with a second click', async () => {
    const { trigger, panel, settle } = await render();
    trigger.click();
    await settle();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect(panel.style.top).toBe('4px');
    trigger.click();
    await settle();
    expect(panel.hidden).toBe(true);
  });

  it('closes after an action and parks the focus on the button', async () => {
    const { fixture, root, trigger, panel, settle } = await render();
    trigger.click();
    await settle();
    root.querySelector<HTMLButtonElement>('#one')!.click();
    await settle();
    expect(fixture.componentInstance.clicks).toBe(1);
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes with Esc and returns the focus; Esc does nothing when closed', async () => {
    const { root, trigger, panel, settle } = await render();
    const closedEsc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    const closedStop = vi.spyOn(closedEsc, 'stopPropagation');
    trigger.dispatchEvent(closedEsc);
    expect(closedStop).not.toHaveBeenCalled();
    trigger.click();
    await settle();
    const one = root.querySelector<HTMLButtonElement>('#one')!;
    one.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    const stop = vi.spyOn(event, 'stopPropagation');
    one.dispatchEvent(event);
    await settle();
    expect(stop).toHaveBeenCalled();
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when the focus leaves, not when it moves inside', async () => {
    const { root, trigger, panel, settle } = await render();
    trigger.click();
    await settle();
    const one = root.querySelector<HTMLButtonElement>('#one')!;
    trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: one }));
    await settle();
    expect(panel.hidden).toBe(false);
    one.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: root.querySelector('#outside') }),
    );
    await settle();
    expect(panel.hidden).toBe(true);
  });

  it('closes when the window is resized', async () => {
    const { trigger, panel, settle } = await render();
    trigger.click();
    await settle();
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(panel.hidden).toBe(true);
  });
});
