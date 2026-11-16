import { API, backend } from '../../../testing/api';
import { fakeImage } from '../../../testing/companies';
import { emulateNativeDialog } from '../../../testing/dialog';
import { COMPANY, GROUP, fakePlace, renderPlace } from '../../../testing/places';
import {
  cleanUp,
  failPut,
  fieldsetOf,
  READ_ONLY,
  savePut,
  storedBlock,
  submitTab,
  withValue,
} from '../../../testing/places-tabs';

const f = (key: string) => `PLACES.F.MEDIA.${key}`;
const SLOT = (name: string) => `PLACES.MEDIA.SLOT.${name}`;
const SLOTS = [
  'LOGO_LIGHT',
  'COVER_LIGHT',
  'LOGO_KIOSK',
  'COVER_KIOSK',
  'PRODUCT_PLACEHOLDER_KIOSK',
];
const STORED_ID = '6734a1c2e9b1d4a0012ab3f1';
const IMAGES = `${API}/v1/groups/${GROUP}/media/images`;

afterEach(cleanUp);

async function render(options: { permissions?: string[] } = {}) {
  emulateNativeDialog();
  const view = await renderPlace({ path: 'media', ...options });
  backend()
    .expectOne(`${IMAGES}/${STORED_ID}`)
    .flush({ data: fakeImage({ id: STORED_ID }) });
  await view.view();
  const slot = (name: string) => fieldsetOf(view.root, SLOT(name));
  const press = async (name: string, text: string) => {
    (
      [...slot(name).querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === text,
      ) as HTMLButtonElement
    ).click();
    await view.view();
  };
  const slotButtons = (name: string) =>
    [...slot(name).querySelectorAll('.actions button')].map((b) => b.textContent?.trim());
  const choose = async (index: number) => {
    await press(SLOTS[index], 'COMPANIES.MEDIA.CHOOSE');
    backend()
      .expectOne((r) => r.method === 'GET' && r.url === IMAGES && r.params.get('limit') === '12')
      .flush({ data: [fakeImage()], page: { limit: 12, next: null } });
    await view.view();
    view.root.querySelector<HTMLButtonElement>('dialog[open] .image')!.click();
    await view.view();
  };
  return { ...view, slot, press, slotButtons, choose };
}

/** Saves the tab; the stored logo is read again once the saved place comes back. */
async function save(view: Awaited<ReturnType<typeof render>>, body: unknown): Promise<unknown> {
  const sent = await savePut(view, 'media', body);
  for (const request of backend().match(`${IMAGES}/${STORED_ID}`)) {
    request.flush({ data: fakeImage({ id: STORED_ID }) });
  }
  await view.view();
  return sent;
}

describe('PlaceMedia', () => {
  it('shows the files, the five image slots and the preview of the stored logo', async () => {
    const view = await render();
    expect(view.control(f('INTERNAL_FILE_NAME_LOGO')).value).toBe('');
    expect(view.control(f('EXTERNAL_URL_LOGO')).type).toBe('url');
    expect(view.control(f('EXTERNAL_URL')).type).toBe('url');
    expect(view.control(f('INTERNAL_FILE_NAME')).type).toBe('text');
    for (const name of SLOTS) {
      expect(view.slot(name)).toBeDefined();
    }
    expect(view.slot('LOGO_LIGHT').querySelector<HTMLImageElement>('.preview img')?.src).toBe(
      'https://files.test/s/logo.png',
    );
    expect(view.slot('COVER_LIGHT').querySelector('.preview')?.textContent?.trim()).toBe(
      'COMPANIES.MEDIA.NO_LOGO',
    );
    expect(view.slotButtons('LOGO_LIGHT')).toEqual([
      'COMPANIES.MEDIA.CHOOSE',
      'COMPANIES.MEDIA.REMOVE',
    ]);
    expect(view.slotButtons('COVER_LIGHT')).toEqual(['COMPANIES.MEDIA.CHOOSE']);
  });

  it('keeps the stored descriptor when the images are untouched', async () => {
    const view = await render();
    await view.type(f('INTERNAL_FILE_NAME'), 'bar.png');
    await view.type(f('EXTERNAL_URL'), 'https://esempio.it/bar.png');
    await view.type(f('INTERNAL_FILE_NAME_LOGO'), 'logo-bar.png');
    await view.type(f('EXTERNAL_URL_LOGO'), 'https://esempio.it/logo.png');
    let block = withValue(storedBlock('media'), 'internalFileName', 'bar.png');
    block = withValue(block, 'externalUrl', 'https://esempio.it/bar.png');
    block = withValue(block, 'internalFileNameLogo', 'logo-bar.png');
    block = withValue(block, 'externalUrlLogo', 'https://esempio.it/logo.png');
    const body = (await save(view, block)) as { logoLight: unknown };
    expect(body.logoLight).toEqual(fakePlace().media['logoLight']);
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('chooses an image from the library and sends its id', async () => {
    const view = await render();
    await view.choose(1);
    expect(view.slot('COVER_LIGHT').querySelector<HTMLImageElement>('.preview img')?.src).toBe(
      'https://files.test/s/logo.png',
    );
    expect(view.slotButtons('COVER_LIGHT')).toEqual([
      'COMPANIES.MEDIA.CHOOSE',
      'COMPANIES.MEDIA.REMOVE',
    ]);
    await save(view, withValue(storedBlock('media'), 'coverLight', { imageId: fakeImage().id }));
  });

  it('replaces a stored logo with another image', async () => {
    const view = await render();
    await view.choose(4);
    await save(
      view,
      withValue(storedBlock('media'), 'productPlaceholderKiosk', { imageId: fakeImage().id }),
    );
  });

  it('removes a logo and sends null', async () => {
    const view = await render();
    await view.press('LOGO_LIGHT', 'COMPANIES.MEDIA.REMOVE');
    expect(view.slot('LOGO_LIGHT').querySelector('.preview')?.textContent?.trim()).toBe(
      'COMPANIES.MEDIA.NO_LOGO',
    );
    await save(view, withValue(storedBlock('media'), 'logoLight', null));
  });

  it('uploads an image for the company of the place', async () => {
    const view = await render();
    await view.press('LOGO_KIOSK', 'COMPANIES.MEDIA.CHOOSE');
    backend()
      .expectOne((r) => r.method === 'GET' && r.url === IMAGES)
      .flush({ data: [], page: { limit: 12, next: null } });
    await view.view();
    const input = view.root.querySelector<HTMLInputElement>('dialog[open] input[type=file]')!;
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: { item: () => file, length: 1 },
    });
    input.dispatchEvent(new Event('change'));
    await view.view();
    const post = backend().expectOne(`${IMAGES}?companyId=${COMPANY}`);
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toBeInstanceOf(FormData);
    post.flush({ data: fakeImage() }, { status: 201, statusText: 'Created' });
    await view.view();
    backend()
      .expectOne((r) => r.method === 'GET' && r.url === IMAGES)
      .flush({ data: [fakeImage()], page: { limit: 12, next: null } });
    await view.view();
  });

  it('puts the 422 of a file name on its control', async () => {
    const view = await render();
    await view.type(f('EXTERNAL_URL'), 'nope');
    await failPut(view, 'media', [{ field: 'media.externalUrl', issue: 'incorrect' }]);
    expect(view.error(f('EXTERNAL_URL'))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('shows the 422 of an image slot', async () => {
    const view = await render();
    await view.type(f('EXTERNAL_URL'), 'https://x.test');
    await failPut(view, 'media', [{ field: 'media.logoKiosk', issue: 'incorrect' }]);
    expect(view.text()).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form and marks the fields as touched', async () => {
    const view = await render();
    await submitTab(view);
    await view.blurAll();
  });

  it('is read-only without the permission to update', async () => {
    const view = await render({ permissions: READ_ONLY });
    expect(view.control(f('EXTERNAL_URL')).disabled).toBe(true);
    for (const name of SLOTS) {
      expect(view.slotButtons(name)).toEqual([]);
    }
    expect(view.button('COMMON.SAVE')).toBeUndefined();
  });
});
