import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { disabled, form, validate } from '@angular/forms/signals';
import { API, backend, provideApiTesting, settle } from '../../../testing/api';
import { fakeImage, GROUP } from '../../../testing/companies';
import { emulateNativeDialog } from '../../../testing/dialog';
import { coreModelOf } from '../../../testing/product-tabs-b-form';
import { I18nService } from '../../core/i18n/i18n.service';
import { LogoModel } from '../companies/company-model';
import { LogoSlot } from '../companies/logo-slot';
import { MediaPicker } from '../companies/media-picker';
import { CoreModel } from './product-model';
import { ProductMedia } from './product-media';
import { PRODUCT_LIMITS } from './product.types';

const IMAGES = `${API}/v1/groups/${GROUP}/media/images`;
const logo = (label: string): LogoModel => ({ descriptor: null, imageId: null, label, previewUrl: null });

@Component({
  imports: [ProductMedia],
  template: `<fc-product-media [form]="f" [groupId]="groupId" [canUpload]="canUpload()" [imageOnly]="imageOnly()" />`,
})
class Host {
  readonly groupId = GROUP;
  readonly canUpload = signal(true);
  readonly imageOnly = signal(false);
  readonly locked = signal(false);
  readonly model = signal<CoreModel>(coreModelOf());
  readonly f = form(this.model, (path) => {
    disabled(path.image, () => this.locked());
    validate(path.image, ({ value }) => (value()?.label === 'bad' ? { kind: 'server', message: 'Immagine non valida' } : undefined));
    validate(path.gallery, ({ value }) => (value().length > 20 ? { kind: 'server', message: 'Troppe immagini' } : undefined));
    validate(path.internalFileName, ({ value }) => (value() === 'bad' ? { kind: 'server', message: 'Nome non valido' } : undefined));
    validate(path.externalUrl, ({ value }) => (value() === 'bad' ? { kind: 'server', message: 'Link non valido' } : undefined));
  });
}

async function render(change: Partial<CoreModel> = {}) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  host.model.update((model) => ({ ...model, ...change }));
  document.body.appendChild(fixture.nativeElement);
  await settle();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    await fixture.whenStable();
  };
  const slots = () => fixture.debugElement.queryAll(By.directive(LogoSlot));
  const slotButtons = (index: number) =>
    [...(slots()[index].nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.actions button')].map((b) => b.textContent?.trim());
  const press = async (index: number, text: string) => {
    [...(slots()[index].nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.actions button')]
      .find((b) => b.textContent?.trim() === text)!
      .click();
    await view();
  };
  const addButton = () =>
    [...root.querySelectorAll<HTMLButtonElement>('fieldset > .actions button')].find((b) => b.textContent?.trim() === 'PRODUCTS.MEDIA.GALLERY_ADD')!;
  const field = (label: string) =>
    [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)!.control as HTMLInputElement;
  return { fixture, host, root, view, slots, slotButtons, press, addButton, field };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ProductMedia', () => {
  it('shows the main image slot empty, with an empty gallery, and the file name and link fields', async () => {
    const { root, slots, slotButtons, field } = await render();
    expect(slots()).toHaveLength(1);
    expect(root.querySelector('legend')?.textContent).toBe('PRODUCTS.MEDIA.IMAGE');
    expect(root.querySelector('.preview')?.textContent?.trim()).toBe('COMPANIES.MEDIA.NO_LOGO');
    expect(slotButtons(0)).toEqual(['COMPANIES.MEDIA.CHOOSE']);
    expect(root.querySelector('.note')?.textContent).toBe('PRODUCTS.MEDIA.GALLERY_EMPTY');
    expect(root.querySelector('fieldset > .hint')?.textContent).toBe(`PRODUCTS.MEDIA.GALLERY_HINT {"max":${PRODUCT_LIMITS.gallery}}`);
    expect(field('PRODUCT_CATEGORIES.MEDIA.INTERNAL_FILE_NAME').value).toBe('');
    expect(field('PRODUCT_CATEGORIES.MEDIA.EXTERNAL_URL').type).toBe('url');
  });

  it('removes the main image and replaces the ones of the gallery or removes them', async () => {
    const { host, press, slots, view, slotButtons } = await render({ image: logo('Principale'), gallery: [logo('Uno'), logo('Due')] });
    expect(slots()).toHaveLength(3);
    expect(slotButtons(0)).toEqual(['COMPANIES.MEDIA.CHOOSE', 'COMPANIES.MEDIA.REMOVE']);
    slots()[1].componentInstance.logoChange.emit(logo('Nuovo'));
    await view();
    expect(host.model().gallery.map((l) => l.label)).toEqual(['Nuovo', 'Due']);
    await press(2, 'COMPANIES.MEDIA.REMOVE');
    expect(host.model().gallery.map((l) => l.label)).toEqual(['Nuovo']);
    await press(0, 'COMPANIES.MEDIA.REMOVE');
    expect(host.model().image).toBeNull();
  });

  it('sets the main image chosen in its slot', async () => {
    const { host, slots, view } = await render();
    slots()[0].componentInstance.logoChange.emit(logo('Nuova'));
    await view();
    expect(host.model().image?.label).toBe('Nuova');
  });

  it('adds to the gallery an image of the library chosen in the picker', async () => {
    const { fixture, host, addButton, view, root } = await render();
    addButton().click();
    await settle();
    fixture.detectChanges();
    backend()
      .expectOne((r) => r.method === 'GET' && r.url === IMAGES)
      .flush({ data: [fakeImage()], page: { limit: 12, next: null } });
    await view();
    root.querySelector<HTMLButtonElement>('.image')!.click();
    await view();
    expect(host.model().gallery).toMatchObject([
      { descriptor: null, imageId: fakeImage().id, label: 'Logo Bar', previewUrl: 'https://files.test/s/logo.png' },
    ]);
    expect(root.querySelector('.note')).toBeNull();
  });

  it('does not add beyond the limit of the gallery', async () => {
    const full = Array.from({ length: PRODUCT_LIMITS.gallery }, (_, i) => logo(`Img ${i}`));
    const { fixture, host, addButton, view } = await render({ gallery: full });
    expect(addButton().disabled).toBe(true);
    const picker = fixture.debugElement.queryAll(By.directive(MediaPicker)).at(-1)!.componentInstance as MediaPicker;
    picker.picked.emit(fakeImage());
    await view();
    expect(host.model().gallery).toHaveLength(PRODUCT_LIMITS.gallery);
  });

  it('passes the permission to upload to the pickers', async () => {
    const { fixture, host, view } = await render();
    const uploads = () => fixture.debugElement.queryAll(By.directive(MediaPicker)).map((p) => p.componentInstance.canUpload());
    expect(uploads()).toEqual([true, true]);
    host.canUpload.set(false);
    await view();
    expect(uploads()).toEqual([false, false]);
  });

  it('shows only the main image with imageOnly', async () => {
    const { host, root, view, slots } = await render();
    host.imageOnly.set(true);
    await view();
    expect(slots()).toHaveLength(1);
    expect(root.querySelectorAll('legend')).toHaveLength(1);
    expect(root.textContent).not.toContain('PRODUCT_CATEGORIES.MEDIA.INTERNAL_FILE_NAME');
  });

  it('is read only when the image is disabled: no buttons to choose, remove or add', async () => {
    const { host, root, view, slotButtons } = await render({ image: logo('Principale'), gallery: [logo('Uno')] });
    host.locked.set(true);
    await view();
    expect(slotButtons(0)).toEqual([]);
    expect(slotButtons(1)).toEqual([]);
    expect(root.querySelector('fieldset > .actions')).toBeNull();
  });

  it('shows the errors of the image, the gallery, the file name and the link', async () => {
    const { host, root, view } = await render();
    const problems = () => [...root.querySelectorAll('p.problem, .error span')].map((e) => e.textContent?.trim()).filter(Boolean);
    expect(problems()).toEqual([]);
    host.model.update((model) => ({
      ...model,
      image: logo('bad'),
      gallery: Array.from({ length: 21 }, (_, i) => logo(`Img ${i}`)),
      internalFileName: 'bad',
      externalUrl: 'bad',
    }));
    await view();
    expect(problems()).toEqual([
      'Immagine non valida',
      'Troppe immagini',
      'Nome non valido',
      'Link non valido',
    ]);
  });

  it('marks the file name and the link as touched when the user leaves them', async () => {
    const { host, field, view } = await render();
    field('PRODUCT_CATEGORIES.MEDIA.INTERNAL_FILE_NAME').dispatchEvent(new Event('blur'));
    await view();
    expect(host.f.internalFileName().touched()).toBe(true);
    expect(host.f.externalUrl().touched()).toBe(false);
    field('PRODUCT_CATEGORIES.MEDIA.EXTERNAL_URL').dispatchEvent(new Event('blur'));
    await view();
    expect(host.f.externalUrl().touched()).toBe(true);
  });

  it('writes the file name and the link into the form', async () => {
    const { host, field, view } = await render();
    for (const [label, text] of [
      ['PRODUCT_CATEGORIES.MEDIA.INTERNAL_FILE_NAME', 'pizza.png'],
      ['PRODUCT_CATEGORIES.MEDIA.EXTERNAL_URL', 'https://example.com/pizza.png'],
    ]) {
      const input = field(label);
      input.value = text;
      input.dispatchEvent(new Event('input'));
      await view();
    }
    expect(host.model().internalFileName).toBe('pizza.png');
    expect(host.model().externalUrl).toBe('https://example.com/pizza.png');
  });
});
