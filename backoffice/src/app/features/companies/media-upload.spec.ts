import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { fakeImage } from '../../../testing/companies';
import { checkUpload, MediaApi, UPLOAD_MAX_BYTES, uploadErrorMessage } from './media-upload';

function file(type: string, size = 10): File {
  const result = new File(['x'], 'logo.png', { type });
  Object.defineProperty(result, 'size', { value: size });
  return result;
}

describe('checkUpload', () => {
  it('accepts JPEG, PNG and WebP up to 10 MB', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(checkUpload(file(type))).toBeNull();
    }
    expect(checkUpload(file('image/png', UPLOAD_MAX_BYTES))).toBeNull();
  });

  it('rejects another type or a bigger file', () => {
    expect(checkUpload(file('image/svg+xml'))).toBe('type');
    expect(checkUpload(file('', 1))).toBe('type');
    expect(checkUpload(file('image/png', UPLOAD_MAX_BYTES + 1))).toBe('size');
  });
});

describe('uploadErrorMessage', () => {
  const i18n = {
    t: (key: string, params?: object) =>
      params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  } as unknown as I18nService;
  const error = (status: number, code: ApiError['code'], retryAfterSeconds: number | null = null) =>
    new ApiError({ status, code, message: code, retryAfterSeconds });

  it('has a text for each status of the route', () => {
    expect(uploadErrorMessage(i18n, error(413, 'PAYLOAD_TOO_LARGE'))).toBe(
      'COMPANIES.MEDIA.UPLOAD_ERROR.TOO_LARGE',
    );
    expect(uploadErrorMessage(i18n, error(415, 'UNSUPPORTED_MEDIA_TYPE'))).toBe(
      'COMPANIES.MEDIA.UPLOAD_ERROR.UNSUPPORTED',
    );
    expect(uploadErrorMessage(i18n, error(422, 'VALIDATION_ERROR'))).toBe(
      'COMPANIES.MEDIA.UPLOAD_ERROR.INVALID',
    );
    expect(uploadErrorMessage(i18n, error(429, 'RATE_LIMITED'))).toBe(
      'COMPANIES.MEDIA.UPLOAD_ERROR.RATE_LIMITED',
    );
    expect(uploadErrorMessage(i18n, error(429, 'RATE_LIMITED', 30))).toBe(
      'COMPANIES.MEDIA.UPLOAD_ERROR.RATE_LIMITED_WAIT {"seconds":30}',
    );
    expect(uploadErrorMessage(i18n, error(503, 'SERVICE_UNAVAILABLE'))).toBe(
      'COMPANIES.MEDIA.UPLOAD_ERROR.UNAVAILABLE',
    );
  });

  it('uses the central mapping for anything else', () => {
    expect(uploadErrorMessage(i18n, error(500, 'INTERNAL_ERROR'))).toBe(
      'ERRORS.API.INTERNAL_ERROR',
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(uploadErrorMessage(i18n, new Error('x'))).toBe('ERRORS.GENERIC.MESSAGE');
  });
});

describe('MediaApi', () => {
  afterEach(() => backend().verify());

  it('posts the file as multipart with the company in the query', async () => {
    TestBed.configureTestingModule({ providers: [provideApiTesting()] });
    const api = TestBed.inject(MediaApi);
    const image = file('image/png');
    const done = api.upload('g1', image, 'c1');
    const req = backend().expectOne(`${API}/v1/groups/g1/media/images?companyId=c1`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toBeInstanceOf(FormData);
    expect((req.request.body as FormData).get('file')).toBeInstanceOf(File);
    req.flush({ data: fakeImage() }, { status: 201, statusText: 'Created' });
    expect((await done).id).toBe(fakeImage().id);
  });

  it('sends no company when none is given', async () => {
    TestBed.configureTestingModule({ providers: [provideApiTesting()] });
    const done = TestBed.inject(MediaApi).upload('g1', file('image/png'));
    backend().expectOne(`${API}/v1/groups/g1/media/images`).flush({ data: fakeImage() });
    await done;
  });
});
