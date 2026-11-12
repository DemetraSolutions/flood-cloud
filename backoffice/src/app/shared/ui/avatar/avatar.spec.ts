import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Avatar, initialsOf } from './avatar';

@Component({
  imports: [Avatar],
  template: `<fc-avatar [src]="src()" [initials]="'MR'" [label]="label()" [marked]="marked()" />`,
})
class Host {
  readonly src = signal<string | null>(null);
  readonly label = signal('');
  readonly marked = signal(false);
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, host: fixture.componentInstance, avatar: root.querySelector('fc-avatar')! };
}

describe('Avatar', () => {
  it('is decorative and shows the initials without label and image', async () => {
    const { avatar } = await render();
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.hasAttribute('role')).toBe(false);
    expect(avatar.hasAttribute('aria-label')).toBe(false);
    expect(avatar.textContent?.trim()).toBe('MR');
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.classList.contains('marked')).toBe(false);
  });

  it('is exposed as an image with its name when it has a label', async () => {
    const { fixture, host, avatar } = await render();
    host.label.set('Ha un avatar');
    await fixture.whenStable();
    expect(avatar.getAttribute('role')).toBe('img');
    expect(avatar.getAttribute('aria-label')).toBe('Ha un avatar');
    expect(avatar.hasAttribute('aria-hidden')).toBe(false);
  });

  it('shows the image instead of the initials and can be marked', async () => {
    const { fixture, host, avatar } = await render();
    host.src.set('data:image/png;base64,AAAA');
    host.marked.set(true);
    await fixture.whenStable();
    expect(avatar.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(avatar.querySelector('span')).toBeNull();
    expect(avatar.classList.contains('marked')).toBe(true);
  });
});

describe('initialsOf', () => {
  const user = (firstName: string | null, lastName: string | null, username = 'mrossi') => ({
    firstName,
    lastName,
    username,
  });

  it('uses the first letters of first and last name, in capitals', () => {
    expect(initialsOf(user('mario', 'rossi'))).toBe('MR');
    expect(initialsOf(user(' anna ', 'de Luca'))).toBe('AD');
  });

  it('uses the one name there is', () => {
    expect(initialsOf(user('mario', null))).toBe('M');
    expect(initialsOf(user(null, 'rossi'))).toBe('R');
    expect(initialsOf(user('  ', 'rossi'))).toBe('R');
  });

  it('falls back to the first two characters of the username', () => {
    expect(initialsOf(user(null, null, 'zeta'))).toBe('ZE');
    expect(initialsOf(user('', ' ', 'a'))).toBe('A');
  });
});
