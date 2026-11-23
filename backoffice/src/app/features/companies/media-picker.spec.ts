import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppConfig } from '../../core/config/app-config';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { fakeImage, GROUP } from '../../../testing/companies';
import { emulateNativeDialog } from '../../../testing/dialog';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { MediaPicker } from './media-picker';
import { UPLOAD_MAX_BYTES } from './media-upload';

const LIST = `${API}/v1/groups/${GROUP}/media/images`;
const COMPANY_ID = '665f1c2e9b1d4a0012ab34b2';

async function render(companyId: string | null = COMPANY_ID, providers: Provider[] = []) {
  emulateNativeDialog();
  TestBed.configureTestingModule({ providers: [...provideApiTesting(), ...providers] });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(MediaPicker);
  fixture.componentRef.setInput('groupId', GROUP);
  fixture.componentRef.setInput('companyId', companyId ?? undefined);
  const picked = vi.fn();
  fixture.componentInstance.picked.subscribe(picked);
  document.body.appendChild(fixture.nativeElement);
  const root = fixture.nativeElement as HTMLElement;
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  fixture.detectChanges();
  const open = async () => {
    fixture.componentRef.setInput('open', true);
    await view();
  };
  const list = (params: Record<string, string> = {}) =>
    backend().expectOne((r) => {
      if (r.method !== 'GET' || r.url !== LIST) {
        return false;
      }
      const keys = Object.keys(params);
      return keys.every((key) => r.params.get(key) === params[key]);
    });
  const choose = async (file: Partial<File> | null) => {
    const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: { item: () => file as File | null, length: file === null ? 0 : 1 },
    });
    input.dispatchEvent(new Event('change'));
    await view();
  };
  const problem = () => root.querySelector('.problem')?.textContent?.trim() ?? '';
  return { fixture, root, view, open, list, choose, picked, problem };
}

function imageFile(type = 'image/png', size = 100): File {
  const file = new File(['x'], 'logo.png', { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

afterEach(() => {
  sessionStorage.clear();
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('MediaPicker', () => {
  it('reads nothing while it is closed', async () => {
    await render();
    await settle();
  });

  it('lists the most recent images with their thumbnails once open', async () => {
    const { open, list, root, view } = await render();
    await open();
    const req = list({ limit: '12', sort: '-createdAt' });
    expect(req.request.params.has('q')).toBe(false);
    expect(req.request.params.has('cursor')).toBe(false);
    req.flush({
      data: [
        fakeImage(),
        fakeImage({ id: '6734a1c2e9b1d4a0012ab3f3', name: 'Senza anteprima', urls: null }),
      ],
      page: { limit: 12, next: null },
    });
    await view();
    const thumbs = root.querySelectorAll<HTMLImageElement>('.image img');
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0].src).toBe('https://files.test/xs/logo.png');
    expect(root.textContent).toContain('COMPANIES.MEDIA.NO_PREVIEW');
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });

  it('says so when the library is empty and while it loads', async () => {
    const { open, list, root, view } = await render();
    await open();
    expect(root.textContent).toContain('COMMON.LOADING');
    list().flush({ data: [], page: { limit: 12, next: null } });
    await view();
    expect(root.textContent).toContain('COMPANIES.MEDIA.EMPTY');
  });

  it('closes from the footer button and from the close button of the header', async () => {
    const { open, list, root, view, fixture } = await render();
    await open();
    list().flush({ data: [], page: { limit: 12, next: null } });
    await view();
    const footer = [...root.querySelectorAll<HTMLButtonElement>('footer button')].find(
      (b) => b.textContent?.trim() === 'COMMON.CLOSE',
    )!;
    footer.click();
    await view();
    expect(fixture.componentInstance.open()).toBe(false);
    fixture.componentInstance.open.set(true);
    await view();
    list().flush({ data: [], page: { limit: 12, next: null } });
    await view();
    root.querySelector<HTMLButtonElement>('header button')!.click();
    await view();
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('chooses an image, reports it and closes', async () => {
    const { open, list, root, view, picked, fixture } = await render();
    await open();
    list().flush({ data: [fakeImage()], page: { limit: 12, next: null } });
    await view();
    root.querySelector<HTMLButtonElement>('.image')!.click();
    await view();
    expect(picked).toHaveBeenCalledWith(fakeImage());
    expect(fixture.componentInstance.open()).toBe(false);
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  it('searches after the user stops typing and starts over from the first page', async () => {
    const { open, list, root, view } = await render();
    await open();
    list().flush({ data: [], page: { limit: 12, next: null } });
    await view();
    const search = root.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = ' logo ';
    search.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await view();
    list({ q: 'logo' }).flush({ data: [], page: { limit: 12, next: null } });
    await view();
  });

  it('pages forward and back with the cursor', async () => {
    const { open, list, root, view } = await render();
    await open();
    list().flush({ data: [fakeImage()], page: { limit: 12, next: 'c2' } });
    await view();
    const [previous, next] = [...root.querySelectorAll<HTMLButtonElement>('.pages button')];
    expect(previous.disabled).toBe(true);
    next.click();
    await view();
    list({ cursor: 'c2' }).flush({ data: [fakeImage()], page: { limit: 12, next: null } });
    await view();
    expect(next.disabled).toBe(true);
    expect(previous.disabled).toBe(false);
    previous.click();
    await view();
    const first = list();
    expect(first.request.params.has('cursor')).toBe(false);
    first.flush({ data: [fakeImage()], page: { limit: 12, next: 'c2' } });
    await view();
  });

  it('shows an error with a retry when the library cannot be read', async () => {
    const { open, list, root, view } = await render();
    await open();
    list().flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view();
    expect(root.textContent).toContain('COMPANIES.MEDIA.LOAD_ERROR');
    expect(root.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    root.querySelector<HTMLButtonElement>('fc-error-state button')!.click();
    await view();
    list().flush({ data: [], page: { limit: 12, next: null } });
    await view();
  });

  it('shows a generic message when the failure is not an API error', async () => {
    const { open, root, view } = await render(COMPANY_ID, [
      { provide: AppConfig, useValue: { apiBaseUrl: signal(null) } },
    ]);
    await open();
    expect(root.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  describe('upload', () => {
    it('offers no upload to who may not upload, and still lists the images', async () => {
      const { fixture, open, list, root, view } = await render();
      fixture.componentRef.setInput('canUpload', false);
      await open();
      list().flush({ data: [], page: { limit: 12, next: null } });
      await view();
      expect(root.querySelector('.upload button')).toBeNull();
      expect(root.querySelector('.upload .hint')).toBeNull();
    });

    it('opens the file chooser from the button', async () => {
      const { open, list, root, view } = await render();
      await open();
      list().flush({ data: [], page: { limit: 12, next: null } });
      await view();
      const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
      const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
      root.querySelector<HTMLButtonElement>('.upload button')!.click();
      expect(click).toHaveBeenCalled();
    });

    it('does nothing when the chooser is closed without a file', async () => {
      const { open, list, choose, view } = await render();
      await open();
      list().flush({ data: [], page: { limit: 12, next: null } });
      await view();
      await choose(null);
    });

    it('checks the type and the size before sending', async () => {
      const { open, list, choose, problem, view } = await render();
      await open();
      list().flush({ data: [], page: { limit: 12, next: null } });
      await view();
      await choose(imageFile('image/svg+xml'));
      expect(problem()).toBe('COMPANIES.MEDIA.FILE_TYPE');
      await choose(imageFile('image/png', UPLOAD_MAX_BYTES + 1));
      expect(problem()).toBe('COMPANIES.MEDIA.FILE_SIZE');
    });

    it('uploads for the company and shows the new image', async () => {
      const { open, list, choose, problem, view } = await render();
      const toast = TestBed.inject(ToastService);
      await open();
      list().flush({ data: [], page: { limit: 12, next: null } });
      await view();
      await choose(imageFile());
      const post = backend().expectOne(`${LIST}?companyId=${COMPANY_ID}`);
      expect(post.request.method).toBe('POST');
      expect(post.request.body).toBeInstanceOf(FormData);
      post.flush({ data: fakeImage() }, { status: 201, statusText: 'Created' });
      await view();
      expect(toast.toasts().map((t) => t.message)).toEqual(['COMPANIES.MEDIA.UPLOADED']);
      expect(problem()).toBe('');
      list().flush({ data: [fakeImage()], page: { limit: 12, next: null } });
      await view();
    });

    it('uploads for the whole group when no company is given', async () => {
      const { open, list, choose, view } = await render(null);
      await open();
      list().flush({ data: [], page: { limit: 12, next: null } });
      await view();
      await choose(imageFile());
      backend()
        .expectOne((r) => r.method === 'POST' && r.urlWithParams === LIST)
        .flush({ data: fakeImage() }, { status: 201, statusText: 'Created' });
      await view();
      list().flush({ data: [], page: { limit: 12, next: null } });
      await view();
    });

    it.each([
      [413, 'PAYLOAD_TOO_LARGE', 'COMPANIES.MEDIA.UPLOAD_ERROR.TOO_LARGE', {}],
      [415, 'UNSUPPORTED_MEDIA_TYPE', 'COMPANIES.MEDIA.UPLOAD_ERROR.UNSUPPORTED', {}],
      [422, 'VALIDATION_ERROR', 'COMPANIES.MEDIA.UPLOAD_ERROR.INVALID', {}],
      [
        429,
        'RATE_LIMITED',
        'COMPANIES.MEDIA.UPLOAD_ERROR.RATE_LIMITED_WAIT {"seconds":12}',
        { 'Retry-After': '12' },
      ],
      [503, 'SERVICE_UNAVAILABLE', 'COMPANIES.MEDIA.UPLOAD_ERROR.UNAVAILABLE', {}],
    ])('shows the %i of the upload', async (status, code, message, headers) => {
      const { open, list, choose, problem, view } = await render();
      await open();
      list().flush({ data: [], page: { limit: 12, next: null } });
      await view();
      await choose(imageFile());
      backend()
        .expectOne(`${LIST}?companyId=${COMPANY_ID}`)
        .flush(errorBody(code), { status, statusText: 'x', headers });
      await view();
      expect(problem()).toBe(message);
    });
  });
});
