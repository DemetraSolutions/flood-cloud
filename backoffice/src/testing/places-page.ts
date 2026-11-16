import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { backend, errorBody } from './api';
import { emulateNativeDialog } from './dialog';
import { fakeCompany } from './companies';
import { ETAG, PLACE, PLACE_URL, answerPlaceLookups, fakePlace, renderPlace } from './places';
import { PlaceRecord } from '../app/features/places/place.types';

type RenderOptions = Parameters<typeof renderPlace>[0];

/**
 * Answers the reads of the company of the place (the invoice series). The state asks for it again
 * whenever the model changes, so a test settles them before it moves on or ends.
 */
export function drainSeries(): void {
  for (const request of backend().match(
    (r) => r.method === 'GET' && /\/companies\/[0-9a-f]{24}$/.test(r.url),
  )) {
    if (!request.cancelled) {
      request.flush({ data: fakeCompany() });
    }
  }
}

/** The place page with the tab navigation, the leave dialog and the router at hand. */
export async function renderPlacePage(options: RenderOptions = {}) {
  emulateNativeDialog();
  const view = await renderPlace(options);
  if (options?.lookups !== false) {
    // Lookups that depend on others (the series of the company) are asked for a round later.
    await answerPlaceLookups(options?.lookupData);
    await view.view();
  }
  const router = TestBed.inject(Router);
  const tabs = () => [...view.root.querySelectorAll<HTMLAnchorElement>('nav a')];
  const tabNames = () => tabs().map((a) => a.getAttribute('href')!.split('/').pop());
  const goTo = async (path: string) => {
    drainSeries();
    tabs()
      .find((a) => a.getAttribute('href')!.endsWith(path))!
      .click();
    await view.view();
    // A tab may ask for lookups of its own.
    await answerPlaceLookups();
    await view.view();
  };
  const leave = async () => {
    const navigation = router.navigateByUrl('/elsewhere');
    await view.view();
    return navigation;
  };
  const dialogButton = (text: string) =>
    [...view.root.querySelectorAll<HTMLButtonElement>('dialog[open] button')].find(
      (b) => b.textContent?.trim() === text,
    )!;
  /** The control with the given label inside an element (the `nth` match, for repeated labels). */
  const within = (scope: Element, label: string, nth = 0) => {
    const element = [...scope.querySelectorAll('label')].filter(
      (l) => l.textContent?.trim() === label,
    )[nth];
    return scope.querySelector<HTMLInputElement | HTMLSelectElement>(`#${element.htmlFor}`)!;
  };
  /** Sets a field found by `within`. */
  const typeIn = async (scope: Element, label: string, value: string, nth = 0) => {
    const field = within(scope, label, nth);
    field.value = value;
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input'));
    await view.view();
  };
  const toggleIn = async (scope: Element, label: string, checked: boolean, nth = 0) => {
    const box = within(scope, label, nth) as HTMLInputElement;
    box.checked = checked;
    box.dispatchEvent(new Event('change'));
    await view.view();
  };
  return { ...view, router, tabs, tabNames, goTo, leave, dialogButton, within, typeIn, toggleIn };
}

/** Renders again in a new test module, for tests that compare several users. */
export async function freshPlacePage(options: RenderOptions = {}) {
  backend().verify();
  document.body.replaceChildren();
  TestBed.resetTestingModule();
  return renderPlacePage(options);
}

/** The values of the options of a select. */
export function optionsOf(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.value);
}

/** Answers the next request to the place URL (or a sub-URL) with the given place and version. */
export function flushPlace(
  request: ReturnType<ReturnType<typeof backend>['expectOne']>,
  place: PlaceRecord = fakePlace(),
  etag = '"v2"',
): void {
  request.flush({ data: place }, { headers: { ETag: etag } });
}

/** Expects one request to a sub-URL of the place. */
export function expectPlace(suffix = '') {
  return backend().expectOne(`${PLACE_URL}${suffix}`);
}

/** Fails a request with the error envelope. */
export function fail(
  request: ReturnType<ReturnType<typeof backend>['expectOne']>,
  status: number,
  code: string,
  details?: { field: string; issue: string }[],
): void {
  request.flush(errorBody(code, details), { status, statusText: 'x' });
}

export { ETAG, PLACE };
