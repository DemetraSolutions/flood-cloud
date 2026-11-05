import { ComponentFixture } from '@angular/core/testing';

/** Types into the labelled input of a rendered component and lets the form react. */
export async function typeInto(
  fixture: ComponentFixture<unknown>,
  label: string,
  value: string,
): Promise<HTMLInputElement | HTMLSelectElement> {
  const control = findControl(fixture, label);
  control.value = value;
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input'));
  await fixture.whenStable();
  return control;
}

/** The input or select whose visible label is exactly `label`. */
export function findControl(
  fixture: ComponentFixture<unknown>,
  label: string,
): HTMLInputElement | HTMLSelectElement {
  const root = fixture.nativeElement as HTMLElement;
  const element = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!;
  return root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${element.htmlFor}`)!;
}

/** The error text shown under the field with the given label. */
export function errorOf(fixture: ComponentFixture<unknown>, label: string): string {
  const control = findControl(fixture, label);
  const id = control
    .getAttribute('aria-describedby')
    ?.split(' ')
    .find((i) => i.endsWith('-error'));
  return id === undefined
    ? ''
    : (fixture.nativeElement as HTMLElement).querySelector(`#${id}`)!.textContent!.trim();
}

/** Submits the first form of the component, as the browser does on Enter or button click. */
export async function submitForm(fixture: ComponentFixture<unknown>): Promise<void> {
  const form = (fixture.nativeElement as HTMLElement).querySelector('form')!;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await fixture.whenStable();
}
