import { Type, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { GroupSettingsState } from '../app/features/groups/group-settings-state';
import { I18nService } from '../app/core/i18n/i18n.service';
import { ToastService } from '../app/shared/ui/toast/toast.service';
import { Role } from '../app/core/session/session.types';
import { API, backend, provideApiTesting, settle } from './api';
import { emulateNativeDialog } from './dialog';
import { signIn } from './session';

/** Group of the catalog pages in tests. */
export const CATALOG_GROUP = 'g1';

/**
 * Renders a page of the catalogs of the group record with texts replaced by their keys. The
 * group state is a stand-in that gives the id of the group and the permission to change it.
 *
 * @param page The page component.
 * @param segment URL segment of its catalog.
 * @param canUpdate Whether the user may change the group.
 */
export async function renderCatalogPage<C>(
  page: Type<C>,
  segment: string,
  canUpdate = true,
  options: {
    inputs?: Record<string, unknown>;
    /** Signs in a user with this role and these permissions (both given). */
    user?: { role: Role; permissions: string[] };
  } = {},
) {
  emulateNativeDialog();
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      {
        provide: GroupSettingsState,
        useValue: { groupId: signal(CATALOG_GROUP), canUpdate: signal(canUpdate) },
      },
    ],
  });
  if (options.user !== undefined) {
    signIn(options.user);
  }
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(page);
  for (const [name, value] of Object.entries(options.inputs ?? {})) {
    fixture.componentRef.setInput(name, value);
  }
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const url = `${API}/v1/groups/${CATALOG_GROUP}/${segment}`;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  const click = async (element: Element | null | undefined) => {
    (element as HTMLElement).click();
    await view();
  };
  const control = (label: string) => {
    const element = [...root.querySelectorAll('dialog label')].find(
      (l) => l.textContent?.trim() === label,
    ) as HTMLLabelElement;
    return root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${element.htmlFor}`)!;
  };
  return {
    root,
    url,
    view,
    click,
    control,
    load: async (rows: object[]) => {
      backend().expectOne(url).flush({ data: rows });
      await view();
    },
    type: async (label: string, value: string) => {
      const field = control(label) as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new Event('input'));
      await view();
    },
    submit: async () => {
      root.querySelector('dialog form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await view();
    },
    rows: () => {
      const width = root.querySelectorAll('thead th:not(.actions)').length;
      return [...root.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('th, td')].slice(0, width).map((cell) => cell.textContent?.trim()),
      );
    },
    headers: () =>
      [...root.querySelectorAll('thead th:not(.actions)')].map((h) => h.textContent?.trim()),
    button: (name: string) =>
      [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === name),
    byLabel: (prefix: string, name: string) =>
      root.querySelector<HTMLButtonElement>(`button[aria-label='${prefix} {"name":"${name}"}']`),
    dialogs: () => [...root.querySelectorAll<HTMLDialogElement>('dialog')],
    toasts: () =>
      TestBed.inject(ToastService)
        .toasts()
        .map((t) => [t.kind, t.message]),
  };
}

/** Cleanup to run after each test of a page. */
export function cleanUpPage(): void {
  // The working group is kept in the session storage: a page that follows must not find the group of the previous one.
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
}
