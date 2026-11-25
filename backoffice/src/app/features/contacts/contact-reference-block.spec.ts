import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../core/i18n/i18n.service';
import { ContactReferenceBlock } from './contact-reference-block';
import { ReferenceKind } from './contact-errors';

const KINDS: ReferenceKind[] = [
  { kind: 'sales', count: 3 },
  { kind: 'documents', count: 20 },
  { kind: 'promotions', count: 1 },
];

@Component({
  imports: [ContactReferenceBlock],
  template: `<fc-contact-reference-block
    heading="Non eliminabile"
    message="Ancora in uso"
    [kinds]="kinds()"
    (closed)="closed.set(closed() + 1)"
  />`,
})
class Host {
  readonly kinds = signal(KINDS);
  readonly closed = signal(0);
}

async function render() {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  return { fixture, host: fixture.componentInstance, root: fixture.nativeElement as HTMLElement };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactReferenceBlock', () => {
  it('shows the title and the message in an alert named by its title', async () => {
    const { root } = await render();
    const panel = root.querySelector('[role=alert]')!;
    expect(panel.querySelector('h2')?.textContent).toBe('Non eliminabile');
    expect(panel.getAttribute('aria-labelledby')).toBe(panel.querySelector('h2')?.id);
    expect(panel.querySelector('p')?.textContent).toBe('Ancora in uso');
  });

  it('lists what refers to the entry, kind by kind with its count', async () => {
    const { root } = await render();
    expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'CONTACTS.REFERENCE.ITEM {"kind":"CONTACTS.REFERENCE.sales","count":"3"}',
      'CONTACTS.REFERENCE.ITEM {"kind":"CONTACTS.REFERENCE.documents","count":"CONTACTS.REFERENCE.MANY {\\"count\\":20}"}',
      'CONTACTS.REFERENCE.ITEM {"kind":"CONTACTS.REFERENCE.promotions","count":"1"}',
    ]);
  });

  it('says the list may be longer than what the server lists', async () => {
    const { root } = await render();
    expect(root.querySelector('p.note')?.textContent).toBe('CONTACTS.REFERENCE.MORE_AFTER');
  });

  it('tells the panel was dismissed when the user closes it', async () => {
    const { host, root } = await render();
    const close = root.querySelector('button')!;
    expect(close.textContent?.trim()).toBe('COMMON.CLOSE');
    close.click();
    expect(host.closed()).toBe(1);
  });
});
