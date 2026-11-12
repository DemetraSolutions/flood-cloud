import { OutputEmitterRef, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ApiError } from '../app/core/api/api-error';
import { I18nService } from '../app/core/i18n/i18n.service';
import { ReferenceApi, ReferenceItem } from '../app/core/reference/reference-api';
import { Role } from '../app/core/session/session.types';
import { PlacePerimeter } from '../app/features/groups/catalogs/place-perimeter';
import { API, backend, provideApiTesting, settle } from './api';
import { errorOf, findControl, submitForm, typeInto } from './forms';
import { signIn } from './session';

/** An API error with `details`, as the backend sends it. */
export function apiError(
  code: ApiError['code'],
  details: { field: string; issue: string }[] = [],
): ApiError {
  return new ApiError({ status: code === 'CONFLICT' ? 409 : 422, code, message: code, details });
}

/**
 * Renders a catalog editor with translated texts replaced by their keys, and collects what it
 * emits. `inputs` are set with `setInput`.
 */
export async function renderEditor<B, C extends { save: OutputEmitterRef<B> }>(
  component: Type<C & { cancelled: OutputEmitterRef<void> }>,
  inputs: Record<string, unknown> = {},
  prepare?: (fixture: ComponentFixture<C>) => Promise<void>,
) {
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const fixture = TestBed.createComponent(component);
  document.body.appendChild(fixture.nativeElement);
  const root = fixture.nativeElement as HTMLElement;
  const saved: B[] = [];
  let cancelled = 0;
  fixture.componentInstance.save.subscribe((body) => saved.push(body));
  fixture.componentInstance.cancelled.subscribe(() => cancelled++);
  const set = async (values: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(values)) {
      fixture.componentRef.setInput(name, value);
    }
    await fixture.whenStable();
  };
  if (prepare === undefined) {
    await set(inputs);
  } else {
    // The editor reads the backend: the fixture is not stable until the requests are answered.
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }
    fixture.detectChanges();
    await prepare(fixture);
  }
  const button = (name: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
  return {
    fixture,
    root,
    saved,
    cancelled: () => cancelled,
    set,
    type: (label: string, value: string) => typeInto(fixture, label, value),
    control: (label: string) => findControl(fixture, label),
    check: async (label: string, on: boolean) => {
      const box = findControl(fixture, label) as HTMLInputElement;
      box.checked = on;
      box.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    },
    /** Moves the focus away from every control of the form, as tabbing through it does. */
    blurAll: async () => {
      for (const control of root.querySelectorAll('input, select, textarea')) {
        control.dispatchEvent(new Event('blur'));
      }
      await fixture.whenStable();
    },
    error: (label: string) => errorOf(fixture, label),
    submit: () => submitForm(fixture),
    save: () => button('COMMON.SAVE') as HTMLButtonElement,
    cancel: () => button('COMMON.CANCEL'),
    formError: () => root.querySelector('fc-form-error')?.textContent?.trim() ?? null,
  };
}

/** Cleanup to run after each test of an editor. */
export function cleanUpEditor(): void {
  vi.restoreAllMocks();
  document.body.replaceChildren();
}

/** Stores, products, categories, customers and contact groups the editors of the fidelity pages can offer. */
export const REFERENCE_ITEMS: Readonly<Record<string, ReferenceItem[]>> = {
  places: [
    { id: 'p1', name: 'Centro' },
    { id: 'p2', name: 'Nord' },
  ],
  products: [
    { id: 'prod1', name: 'Caffè' },
    { id: 'prod2', name: 'Cornetto' },
  ],
  'product-categories': [{ id: 'cat1', name: 'Bar' }],
  customers: [
    { id: 'cu1', name: 'Mario Rossi' },
    { id: 'cu2', name: '' },
  ],
  'contact-groups': [{ id: 'cg1', name: 'VIP' }],
};

/**
 * Like {@link renderEditor}, for the editors that read the group (price lists, catalogues…) and
 * offer pickers: the real interceptors over the testing backend, a signed-in user of the given
 * role, and the reference reads (`places`, `lookup`, names) answered from {@link REFERENCE_ITEMS}.
 * `answer` replies to a pending `GET` and lets the form show the result.
 */
export async function renderApiEditor<B, C extends { save: OutputEmitterRef<B> }>(
  component: Type<C & { cancelled: OutputEmitterRef<void> }>,
  inputs: Record<string, unknown> = {},
  options: { role?: Role; names?: Record<string, string> } = {},
) {
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), PlacePerimeter] });
  signIn({ role: options.role ?? 'SA' });
  const page = (items: ReferenceItem[]) => ({ data: items, page: { limit: 25, next: null } });
  const reads = {
    places: vi
      .spyOn(ReferenceApi.prototype, 'places')
      .mockImplementation(async () => page(REFERENCE_ITEMS['places'])),
    lookup: vi
      .spyOn(ReferenceApi.prototype, 'lookup')
      .mockImplementation(async (_group, kind) => page(REFERENCE_ITEMS[kind])),
    placeNames: vi
      .spyOn(ReferenceApi.prototype, 'placeNames')
      .mockImplementation(async () => options.names ?? {}),
    lookupNames: vi
      .spyOn(ReferenceApi.prototype, 'lookupNames')
      .mockImplementation(async () => options.names ?? {}),
  };
  const rendered = await renderEditor<B, C>(component, inputs, async (fixture) => {
    await settle();
    fixture.detectChanges();
    await settle();
  });
  const view = async () => {
    await settle();
    rendered.fixture.detectChanges();
    await settle();
    rendered.fixture.detectChanges();
  };
  return {
    ...rendered,
    reads,
    view,
    /** Replies to the pending `GET` of a path of the group (`/v1/groups/g1/...`). */
    answer: async (path: string, body: object, status = 200) => {
      backend()
        .expectOne(`${API}${path}`)
        .flush(body, { status, statusText: status === 200 ? 'OK' : 'Error' });
      await view();
    },
    /** Ticks the item with that name in the pickers (in the one with that legend, if given), or clears it. */
    pick: async (name: string, on = true, legend?: string) => {
      const scopes =
        legend === undefined
          ? [rendered.root]
          : [...rendered.root.querySelectorAll('fieldset')].filter(
              (f) => f.querySelector(':scope > legend')?.textContent?.trim() === legend,
            );
      const label = scopes
        .flatMap((scope) => [...scope.querySelectorAll('li label')])
        .find((l) => l.textContent?.trim() === name)!;
      const box = label.querySelector('input')!;
      box.checked = on;
      box.dispatchEvent(new Event('change'));
      await view();
    },
    /** Texts of the chosen items of the picker with that legend. */
    chosen: (legend: string) => {
      const group = [...rendered.root.querySelectorAll('fieldset')].find(
        (f) => f.querySelector(':scope > legend')?.textContent?.trim() === legend,
      )!;
      return [...group.querySelectorAll('ul.chosen li > span:first-child')].map((e) =>
        e.textContent?.trim(),
      );
    },
  };
}
