import { backend } from '../../../testing/api';
import { fakePlace, renderPlace } from '../../../testing/places';

const AMOUNT = (code: string) => code;
const READ_ONLY = ['places:read', 'companies:read', 'groups:read', 'products:read', 'profile:read'];

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function withDelivery(minAmount: unknown) {
  const place = fakePlace();
  return fakePlace({ delivery: { ...place.delivery, minAmount } });
}

describe('KeyedValues of the minimum order', () => {
  it('shows a number field for each currency of the group with the stored value', async () => {
    const { control, text } = await renderPlace({ path: 'settings/delivery' });
    expect(text()).toContain('PLACES.DELIVERY.MIN_AMOUNT');
    const eur = control(AMOUNT('EUR'));
    expect(eur.value).toBe('10');
    expect(eur.type).toBe('number');
    expect(eur.getAttribute('inputmode')).toBe('decimal');
    expect(control(AMOUNT('USD')).value).toBe('');
  });

  it('writes the typed value keeping the other currencies', async () => {
    const view = await renderPlace({ path: 'settings/delivery' });
    await view.type('USD', '4.5');
    await view.type('EUR', '12');
    expect(view.control('USD').value).toBe('4.5');
    expect(view.control('EUR').value).toBe('12');
  });

  it('still shows a stored currency the group no longer has', async () => {
    const { control } = await renderPlace({
      path: 'settings/delivery',
      place: withDelivery({ GBP: 3, EUR: 10 }),
    });
    expect(control('GBP').value).toBe('3');
    expect(control('EUR').value).toBe('10');
    expect(control('USD').value).toBe('');
  });

  it('says there is nothing to fill in when there are no currencies', async () => {
    const { text, root } = await renderPlace({
      path: 'settings/delivery',
      place: withDelivery({}),
      lookupData: { currencies: { data: [] } },
    });
    expect(text()).toContain('PLACES.NO_KEYS');
    const legend = [...root.querySelectorAll('legend')].find(
      (l) => l.textContent?.trim() === 'PLACES.DELIVERY.MIN_AMOUNT',
    );
    expect(legend?.parentElement?.querySelectorAll('input')).toHaveLength(0);
  });

  it('shows the fields as read only for a user who cannot update', async () => {
    const { control } = await renderPlace({ path: 'settings/delivery', permissions: READ_ONLY });
    expect(control('EUR').disabled).toBe(true);
    expect(control('USD').disabled).toBe(true);
  });
});

describe('KeyedValues of the kiosk texts', () => {
  it('shows a text field for each language of the group, labelled with its name', async () => {
    const { root, text } = await renderPlace({ path: 'settings/kiosk' });
    const labels = [...root.querySelectorAll('label')].map((l) => l.textContent?.trim() ?? '');
    const italian = labels.filter((l) => l.endsWith('(it)'));
    const english = labels.filter((l) => l.endsWith('(en)'));
    expect(italian).toHaveLength(5);
    expect(english).toHaveLength(5);
    expect(text()).toContain('PLACES.KIOSK.TEXT.TITLE_TEXT');
    expect(text()).toContain('PLACES.KIOSK.TEXT.TAKE_AWAY_TEXT');
  });

  it('shows the stored text and writes a new one as text', async () => {
    const view = await renderPlace({ path: 'settings/kiosk' });
    const label = [...view.root.querySelectorAll('label')]
      .map((l) => l.textContent?.trim() ?? '')
      .find((l) => l.endsWith('(it)')) as string;
    const field = view.control(label);
    expect(field.value).toBe('Benvenuti');
    expect(field.type).toBe('text');
    expect(field.getAttribute('inputmode')).toBeNull();
    await view.type(label, 'Ciao a tutti');
    expect(view.control(label).value).toBe('Ciao a tutti');
  });

  it('keeps the texts of a language the group no longer has', async () => {
    const base = fakePlace();
    const { root } = await renderPlace({
      path: 'settings/kiosk',
      place: fakePlace({ kiosk: { ...base.kiosk, titleText: { it: 'A', fr: 'Bonjour' } } }),
    });
    const values = [...root.querySelectorAll<HTMLInputElement>('input')].map((i) => i.value);
    expect(values).toContain('Bonjour');
  });
});
