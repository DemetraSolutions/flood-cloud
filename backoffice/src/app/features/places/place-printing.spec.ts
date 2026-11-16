import { renderPlace } from '../../../testing/places';
import { cleanUp } from '../../../testing/places-tabs';

const CA = { role: 'CA', groupId: '665f1c2e9b1d4a0012ab34a1' } as const;

const parts = (view: Awaited<ReturnType<typeof renderPlace>>) =>
  [...view.root.querySelectorAll('h3.part')].map((h) => h.textContent?.trim());
const legends = (view: Awaited<ReturnType<typeof renderPlace>>) =>
  [...view.root.querySelectorAll('fc-place-printing legend')].map((l) => l.textContent?.trim());

afterEach(cleanUp);

describe('PlacePrinting', () => {
  it('shows the receipt, the pre-bill and the order, with their sections, to a platform administrator', async () => {
    const view = await renderPlace({ path: 'settings/print' });
    expect(parts(view)).toEqual([
      'PLACES.PART.PRINT_RECEIPT',
      'PLACES.PART.PRINT_PREBILLING',
      'PLACES.PART.PRINT_ORDERING',
    ]);
    expect(legends(view).length).toBeGreaterThanOrEqual(3);
    expect(legends(view).every((legend) => legend !== undefined && legend !== '')).toBe(true);
  });

  it('shows only the receipt to a company administrator of a group without the ordering module', async () => {
    const view = await renderPlace({ path: 'settings/print', features: [], profile: CA });
    expect(parts(view)).toEqual(['PLACES.PART.PRINT_RECEIPT']);
  });

  it('shows the pre-bill and the order to a company administrator of a group with the module', async () => {
    const view = await renderPlace({ path: 'settings/print', features: ['ordering'], profile: CA });
    expect(parts(view)).toEqual([
      'PLACES.PART.PRINT_RECEIPT',
      'PLACES.PART.PRINT_PREBILLING',
      'PLACES.PART.PRINT_ORDERING',
    ]);
  });

  it('does not submit the form natively', async () => {
    const view = await renderPlace({ path: 'settings/print' });
    const form = view.root.querySelector('fc-place-printing form') as HTMLFormElement;
    const event = new Event('submit', { cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
