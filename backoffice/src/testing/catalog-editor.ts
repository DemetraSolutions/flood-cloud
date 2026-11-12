import { OutputEmitterRef, Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiError } from '../app/core/api/api-error';
import { I18nService } from '../app/core/i18n/i18n.service';
import { errorOf, findControl, submitForm, typeInto } from './forms';

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
  await set(inputs);
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
      for (const control of root.querySelectorAll('input, select')) {
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
