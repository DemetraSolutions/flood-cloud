import { backend, errorBody } from './api';
import { ETAG, PLACE_URL, fakePlace } from './places';
import { SettingsBlockName } from '../app/features/places/place.types';

/** What `renderPlace` returns. */
type Rendered = Awaited<ReturnType<typeof import('./places').renderPlace>>;

/** Standard cleanup of the place specs. */
export function cleanUp(): void {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
}

/** A deep copy of a settings block of the default place, to build the expected body from. */
export function storedBlock(block: SettingsBlockName): Record<string, unknown> {
  return structuredClone(fakePlace()[block]) as Record<string, unknown>;
}

/** Sets a value at a dotted path of a copy of a block. */
export function withValue(
  block: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = path.split('.');
  let node = block;
  for (const segment of segments.slice(0, -1)) {
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
  return block;
}

/** The section of the place each old `PUT` path wrote (the unique save sends the blocks by section). */
const SECTION_OF_PATH: Record<string, string> = {
  license: 'license',
  'opening-hours': 'openingHours',
  'settings/cash': 'cashSettings',
  'settings/printing': 'printing',
  'settings/payments': 'payments',
  'settings/tables': 'tables',
  'settings/reservations': 'reservations',
  'settings/delivery': 'delivery',
  'settings/self-ordering': 'selfOrdering',
  'settings/kiosk': 'kiosk',
  'settings/appointments': 'appointments',
  'settings/external-display': 'externalDisplay',
  'settings/fidelity': 'fidelity',
  'settings/tobacco': 'tobacco',
  media: 'media',
  integrations: 'integrations',
  'settings/dealer': 'dealerSettings',
  devices: 'devices',
  'print-stations': 'printStations',
  rooms: 'rooms',
  storages: 'storages',
};

/**
 * Presses the one save of the page, checks the `PATCH` (URL, `If-Match`, body) and answers with
 * the saved place. `body` is the whole body of the request, by section.
 */
export async function savePatch(
  view: Rendered,
  body: unknown,
  etag: string = ETAG,
): Promise<unknown> {
  await view.click('COMMON.SAVE');
  const request = backend().expectOne(PLACE_URL);
  expect(request.request.method).toBe('PATCH');
  expect(request.request.headers.get('If-Match')).toBe(etag);
  expect(request.request.body).toEqual(body);
  const sent = request.request.body;
  request.flush({ data: fakePlace() }, { headers: { ETag: '"v2"' } });
  await view.view();
  return sent;
}

/**
 * Presses save and checks that the block of the section of an old `PUT` path went in the `PATCH`
 * (`path` is that path: `settings/payments`); `block` is what the section holds in the body.
 */
export async function savePut(
  view: Rendered,
  path: string,
  block: unknown,
  etag: string = ETAG,
): Promise<unknown> {
  const sent = (await savePatch(view, { [SECTION_OF_PATH[path]]: block }, etag)) as Record<
    string,
    unknown
  >;
  return sent[SECTION_OF_PATH[path]];
}

/** Presses save and fails the `PATCH` with a `422` carrying the given details. */
export async function failSave(
  view: Rendered,
  details: { field: string; issue: string }[],
): Promise<void> {
  await view.click('COMMON.SAVE');
  backend()
    .expectOne(PLACE_URL)
    .flush(errorBody('VALIDATION_ERROR', details), { status: 422, statusText: 'x' });
  await view.view();
}

/** As {@link failSave}; `path` is the old `PUT` path, which the unique save no longer has. */
export async function failPut(
  view: Rendered,
  _path: string,
  details: { field: string; issue: string }[],
): Promise<void> {
  await failSave(view, details);
}

/** The permissions of a user who can only read places. */
export const READ_ONLY = [
  'places:read',
  'companies:read',
  'groups:read',
  'products:read',
  'profile:read',
];

/** Whether the labelled checkbox is checked. */
export function isChecked(view: Rendered, label: string): boolean {
  return (view.control(label) as HTMLInputElement).checked;
}

/** Submits the form of the open tab, as the browser does on Enter. */
export async function submitTab(view: Rendered): Promise<void> {
  view.root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await view.view();
}

/** The control labelled `label` inside `scope` (a fieldset of the tab, for repeated labels). */
export function within(scope: Element, label: string): HTMLInputElement | HTMLSelectElement {
  const found = [...scope.querySelectorAll('label')].find((l) => l.textContent?.trim() === label);
  return scope.querySelector(`#${(found as HTMLLabelElement).htmlFor}`) as
    HTMLInputElement | HTMLSelectElement;
}

/** The fieldset whose own legend is `legend`. */
export function fieldsetOf(root: Element, legend: string): HTMLFieldSetElement {
  return [...root.querySelectorAll('fieldset')].find(
    (candidate) => candidate.querySelector(':scope > legend')?.textContent?.trim() === legend,
  ) as HTMLFieldSetElement;
}

/** Types into a control found with {@link within}, as a user does. */
export async function typeWithin(
  view: Rendered,
  scope: Element,
  label: string,
  value: string,
): Promise<void> {
  const field = within(scope, label);
  field.value = value;
  field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input'));
  await view.view();
}

/** Clicks a button of the tab by its exact text, inside `scope` when given. */
export async function clickIn(view: Rendered, scope: Element, text: string): Promise<void> {
  (
    [...scope.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement
  ).click();
  await view.view();
}
