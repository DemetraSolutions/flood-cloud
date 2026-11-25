import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { I18nService } from '../app/core/i18n/i18n.service';
import { Role } from '../app/core/session/session.types';
import { API, backend, provideApiTesting, settle } from './api';
import { signIn } from './session';

/** The providers of the integrations module. */
export type Providers = Partial<
  Record<'cerved' | 'dojo' | 'satispay' | 'tsh' | 'geocoding', boolean>
>;

/** What {@link mountIntegration} takes besides the inputs. */
export interface MountOptions {
  role?: Role;
  permissions?: string[];
  /** Providers the platform has configured; none when absent. */
  providers?: Providers;
  /** Whether to answer `GET /v1/integrations` (default); `false` leaves it pending. */
  answer?: boolean;
}

/** Standard cleanup of the specs of the module. */
export function cleanUpIntegrations(): void {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
}

/**
 * Mounts a component of the integrations module alone, signs a user in and answers the read of
 * the availability of the providers. Texts come back as their dictionary keys (with the
 * parameters as JSON when there are any).
 */
export async function mountIntegration<T>(
  component: Type<T>,
  inputs: Record<string, unknown>,
  options: MountOptions = {},
) {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  signIn({
    role: options.role ?? 'PSA',
    groupId: null,
    permissions: options.permissions ?? ['places:read', 'places:update', 'groups:create'],
  });
  const fixture: ComponentFixture<T> = TestBed.createComponent(component);
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  document.body.appendChild(fixture.nativeElement);
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await view();
  if (options.answer !== false) {
    backend()
      .expectOne(`${API}/v1/integrations`)
      .flush({
        data: {
          cerved: false,
          dojo: false,
          satispay: false,
          tsh: false,
          geocoding: false,
          ...options.providers,
        },
      });
    await view();
  }
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')];
  const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text);
  const click = async (text: string) => {
    (button(text) as HTMLButtonElement).click();
    await view();
  };
  return { fixture, component: fixture.componentInstance, root, view, button, buttons, click };
}
