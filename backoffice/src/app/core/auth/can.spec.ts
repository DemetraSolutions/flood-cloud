import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { signIn } from '../../../testing/session';
import { Can } from './can';

@Component({
  imports: [Can],
  template: `<button *fcCan="permission()">Crea</button>`,
})
class Host {
  readonly permission = signal('users:create');
}

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
});

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

describe('Can', () => {
  it('renders the content when the user holds the permission', async () => {
    signIn({ permissions: ['users:create'] });
    const { root } = await render();
    expect(root.querySelector('button')).not.toBeNull();
  });

  it('renders nothing without the permission', async () => {
    signIn({ permissions: ['users:read'] });
    const { root } = await render();
    expect(root.querySelector('button')).toBeNull();
  });

  it('renders nothing for an anonymous visitor', async () => {
    const { root } = await render();
    expect(root.querySelector('button')).toBeNull();
  });

  it('follows the session: appears and disappears, creating the view once', async () => {
    signIn({ permissions: [] });
    const { fixture, root } = await render();
    expect(root.querySelector('button')).toBeNull();
    signIn({ permissions: ['users:create'] });
    await fixture.whenStable();
    expect(root.querySelectorAll('button').length).toBe(1);
    signIn({ permissions: ['users:create', 'users:read'] });
    await fixture.whenStable();
    expect(root.querySelectorAll('button').length).toBe(1);
    signIn({ permissions: [] });
    await fixture.whenStable();
    expect(root.querySelector('button')).toBeNull();
  });

  it('follows a change of the required permission', async () => {
    signIn({ permissions: ['users:create'] });
    const { fixture, root } = await render();
    fixture.componentInstance.permission.set('users:delete');
    await fixture.whenStable();
    expect(root.querySelector('button')).toBeNull();
  });
});
