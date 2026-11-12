import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TabItem, TabList } from './tab-list';

@Component({
  imports: [TabList],
  template: `<fc-tab-list label="Sezioni" idPrefix="x" [tabs]="tabs()" [(active)]="active" />`,
})
class Host {
  readonly active = signal('a');
  readonly tabs = signal<TabItem[]>([
    { id: 'a', label: 'Alfa' },
    { id: 'b', label: 'Beta', errors: 2 },
    { id: 'c', label: 'Gamma', errors: 0 },
  ]);
}

async function render() {
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const tabs = () => [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  const press = async (key: string) => {
    root
      .querySelector('[role=tablist]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await fixture.whenStable();
  };
  return { fixture, host: fixture.componentInstance, root, tabs, press };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('TabList', () => {
  it('is a named tablist whose tabs point at their panels', async () => {
    const { root, tabs } = await render();
    expect(root.querySelector('[role=tablist]')?.getAttribute('aria-label')).toBe('Sezioni');
    expect(tabs().map((t) => t.id)).toEqual(['x-tab-a', 'x-tab-b', 'x-tab-c']);
    expect(tabs().map((t) => t.getAttribute('aria-controls'))).toEqual([
      'x-panel-a',
      'x-panel-b',
      'x-panel-c',
    ]);
  });

  it('marks the active tab and makes only it reachable with Tab', async () => {
    const { tabs } = await render();
    expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it('shows the error count of the tabs that have errors', async () => {
    const { tabs } = await render();
    expect(tabs()[0].querySelector('fc-status-badge')).toBeNull();
    expect(tabs()[1].querySelector('fc-status-badge')?.textContent?.trim()).toBe(
      'TAB_LIST.ERRORS {"count":2}',
    );
    expect(tabs()[2].querySelector('fc-status-badge')).toBeNull();
  });

  it('activates a tab on click', async () => {
    const { host, tabs, fixture } = await render();
    tabs()[2].click();
    await fixture.whenStable();
    expect(host.active()).toBe('c');
  });

  it('moves with the arrow keys, wrapping around, and with Home and End', async () => {
    const { host, tabs, press } = await render();
    await press('ArrowRight');
    expect(host.active()).toBe('b');
    expect(document.activeElement).toBe(tabs()[1]);
    await press('End');
    expect(host.active()).toBe('c');
    await press('ArrowRight');
    expect(host.active()).toBe('a');
    await press('ArrowLeft');
    expect(host.active()).toBe('c');
    await press('Home');
    expect(host.active()).toBe('a');
    await press('ArrowLeft');
    expect(host.active()).toBe('c');
  });

  it('ignores other keys', async () => {
    const { host, press } = await render();
    await press('x');
    expect(host.active()).toBe('a');
  });
});
