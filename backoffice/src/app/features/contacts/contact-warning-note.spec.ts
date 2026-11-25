import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { ContactApi } from './contact-api';
import { ContactWarningNote } from './contact-warning-note';
import { ContactWarning } from './contact.types';

const WARNING: ContactWarning = {
  field: 'code',
  issue: 'duplicate',
  value: 'C-1',
  contactIds: ['aaaaaa111111', 'bbbbbb222222'],
  others: 0,
};

async function render(
  namesUsing: ReturnType<typeof vi.fn>,
  warning?: ContactWarning,
  pending = false,
) {
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: ContactApi, useValue: { namesUsing } }],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(ContactWarningNote);
  fixture.componentRef.setInput('groupId', 'g1');
  fixture.componentRef.setInput('warning', warning);
  // A read that never ends keeps the fixture unstable: only wait for the first render.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!pending) {
    await fixture.whenStable();
  }
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, root, links: () => [...root.querySelectorAll('a')] };
}

afterEach(() => vi.restoreAllMocks());

describe('ContactWarningNote', () => {
  it('shows nothing without a warning and reads nothing', async () => {
    const namesUsing = vi.fn();
    const { root } = await render(namesUsing);
    expect(root.querySelector('p')).toBeNull();
    expect(namesUsing).not.toHaveBeenCalled();
  });

  it('links each contact by its name, searched by the value, and never shows an id', async () => {
    const namesUsing = vi.fn().mockResolvedValue({ aaaaaa111111: 'Anna Verdi' });
    const { root, links } = await render(namesUsing, WARNING);
    expect(namesUsing).toHaveBeenCalledWith('g1', 'C-1', ['aaaaaa111111', 'bbbbbb222222']);
    const note = root.querySelector('p')!;
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toContain('CONTACTS.WARNING.DUPLICATE');
    expect(links().map((link) => link.textContent)).toEqual([
      'Anna Verdi',
      'CONTACTS.WARNING.CONTACT_N {"number":2}',
    ]);
    expect(links()[0].getAttribute('href')).toBe('/groups/g1/contacts/aaaaaa111111');
    expect(note.textContent).toContain('Anna Verdi, ');
    expect(note.textContent).not.toContain('111111');
    expect(note.textContent).not.toContain('CONTACTS.WARNING.OTHERS');
  });

  it('numbers the contacts while the names are being read', async () => {
    const { links } = await render(
      vi.fn().mockReturnValue(new Promise(() => undefined)),
      WARNING,
      true,
    );
    expect(links().map((link) => link.textContent)).toEqual([
      'CONTACTS.WARNING.CONTACT_N {"number":1}',
      'CONTACTS.WARNING.CONTACT_N {"number":2}',
    ]);
  });

  it('numbers the contacts and logs only the code when the read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new ApiError({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'https://x/contacts?q=C-1',
    });
    const { links } = await render(vi.fn().mockRejectedValue(error), WARNING);
    expect(links()).toHaveLength(2);
    expect(links()[0].textContent).toBe('CONTACTS.WARNING.CONTACT_N {"number":1}');
    expect(warn).toHaveBeenCalledWith(
      'Cannot read the names of the contacts that use the same value',
      'INTERNAL_ERROR',
    );
  });

  it('logs an unexpected failure as such', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await render(vi.fn().mockRejectedValue(new Error('boom')), WARNING);
    expect(warn).toHaveBeenCalledWith(
      'Cannot read the names of the contacts that use the same value',
      'unexpected',
    );
  });

  it.each([
    ['has no value', { ...WARNING, value: undefined }],
    ['has an empty value', { ...WARNING, value: '' }],
    ['names no contact', { ...WARNING, contactIds: [], others: 2 }],
  ])('reads nothing when the warning %s', async (_name, warning) => {
    const namesUsing = vi.fn();
    const { links } = await render(namesUsing, warning as ContactWarning);
    expect(namesUsing).not.toHaveBeenCalled();
    if (warning.contactIds.length === 0) {
      expect(links()).toHaveLength(0);
    }
  });

  it('says how many other contacts use the value', async () => {
    const { root } = await render(vi.fn().mockResolvedValue({}), { ...WARNING, others: 3 });
    expect(root.textContent).toContain('CONTACTS.WARNING.OTHERS {"count":3}');
  });

  it('has no links to offer while there is no warning', async () => {
    const { fixture } = await render(vi.fn());
    expect((fixture.componentInstance as unknown as { links(): unknown[] }).links()).toEqual([]);
  });
});
