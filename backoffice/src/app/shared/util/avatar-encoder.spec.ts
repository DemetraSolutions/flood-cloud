import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import {
  AVATAR_MAX_BYTES,
  AVATAR_SOURCE_MAX_BYTES,
  AvatarEncoder,
  AvatarError,
  dataUrlBytes,
} from './avatar-encoder';

const SMALL = 'AAAA'; // 3 bytes
const BIG = 'A'.repeat(300_000); // 225,000 bytes: over the limit

const urlOf = (type: string, payload: string) => `data:${type};base64,${payload}`;

describe('dataUrlBytes', () => {
  it.each([
    ['AAAA', 3],
    ['AAA=', 2],
    ['AA==', 1],
    ['', 0],
  ])('payload "%s" -> %d bytes', (payload, bytes) => {
    expect(dataUrlBytes(urlOf('image/png', payload))).toBe(bytes);
  });
});

describe('AvatarEncoder', () => {
  let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> };
  let canvas: {
    width: number;
    height: number;
    getContext: ReturnType<typeof vi.fn>;
    toDataURL: ReturnType<typeof vi.fn>;
  };
  let context: { drawImage: ReturnType<typeof vi.fn> };
  let createImageBitmap: ReturnType<typeof vi.fn>;
  let encoder: AvatarEncoder;

  const png = () => new File(['x'], 'a.png', { type: 'image/png' });

  beforeEach(() => {
    bitmap = { width: 1000, height: 500, close: vi.fn() };
    context = { drawImage: vi.fn() };
    canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toDataURL: vi.fn((type: string) => urlOf(type, SMALL)),
    };
    createImageBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { createElement: () => canvas } }],
    });
    encoder = TestBed.inject(AvatarEncoder);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('refuses a type the backend does not accept, without decoding it', async () => {
    const file = new File(['x'], 'a.gif', { type: 'image/gif' });
    await expect(encoder.encode(file)).rejects.toMatchObject({ problem: 'type' });
    await expect(encoder.encode(file)).rejects.toBeInstanceOf(AvatarError);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('refuses a file over the source limit before reading or decoding it', async () => {
    const file = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: AVATAR_SOURCE_MAX_BYTES + 1 });
    await expect(encoder.encode(file)).rejects.toMatchObject({ problem: 'file' });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('accepts a file exactly at the source limit', async () => {
    const file = new File(['x'], 'edge.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: AVATAR_SOURCE_MAX_BYTES });
    expect(await encoder.encode(file)).toBe(urlOf('image/webp', SMALL));
  });

  it('reports an image that cannot be decoded', async () => {
    createImageBitmap.mockRejectedValue(new Error('broken'));
    await expect(encoder.encode(png())).rejects.toMatchObject({
      problem: 'read',
      name: 'AvatarError',
    });
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it('reports a canvas without a 2d context and releases the bitmap', async () => {
    canvas.getContext.mockReturnValue(null);
    await expect(encoder.encode(png())).rejects.toMatchObject({ problem: 'read' });
    expect(canvas.getContext).toHaveBeenCalledWith('2d');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'])('accepts %s', async (type) => {
    const url = await encoder.encode(new File(['x'], 'a', { type }));
    expect(url).toBe(urlOf('image/webp', SMALL));
  });

  it('returns the WebP of the first attempt, scaled to 256 px keeping the proportions', async () => {
    const url = await encoder.encode(png());
    expect(url).toBe(urlOf('image/webp', SMALL));
    expect(canvas.toDataURL).toHaveBeenCalledOnce();
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', 0.9);
    expect(canvas.width).toBe(256);
    expect(canvas.height).toBe(128);
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 256, 128);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('scales a tall image by its height', async () => {
    bitmap.width = 300;
    bitmap.height = 1200;
    await encoder.encode(png());
    expect([canvas.width, canvas.height]).toEqual([64, 256]);
  });

  it('does not enlarge a small image', async () => {
    bitmap.width = 100;
    bitmap.height = 50;
    await encoder.encode(png());
    expect([canvas.width, canvas.height]).toEqual([100, 50]);
  });

  it('keeps at least one pixel per side', async () => {
    bitmap.width = 4000;
    bitmap.height = 1;
    await encoder.encode(png());
    expect([canvas.width, canvas.height]).toEqual([256, 1]);
  });

  it('lowers the quality until the image fits', async () => {
    canvas.toDataURL.mockImplementation((type: string, quality?: number) =>
      urlOf(type, quality === 0.6 ? SMALL : BIG),
    );
    expect(await encoder.encode(png())).toBe(urlOf('image/webp', SMALL));
    expect(canvas.toDataURL.mock.calls).toEqual([
      ['image/webp', 0.9],
      ['image/webp', 0.75],
      ['image/webp', 0.6],
    ]);
  });

  it('falls back to PNG when the browser cannot encode WebP', async () => {
    canvas.toDataURL.mockImplementation((type: string) =>
      type === 'image/png' ? urlOf('image/png', SMALL) : urlOf('image/png', BIG),
    );
    expect(await encoder.encode(png())).toBe(urlOf('image/png', SMALL));
    expect(canvas.toDataURL).toHaveBeenLastCalledWith('image/png', undefined);
  });

  it('does not take a PNG for the WebP it asked for, even when small', async () => {
    canvas.toDataURL.mockImplementation((_type: string, quality?: number) =>
      urlOf('image/png', quality === undefined ? BIG : SMALL),
    );
    // WebP attempts answer with a (small) PNG: refused; the real PNG attempt is too big, so the
    // next size is tried and refuses the same way until none is left.
    await expect(encoder.encode(png())).rejects.toMatchObject({ problem: 'size' });
  });

  it('shrinks the image when no encoding of the larger size fits', async () => {
    canvas.toDataURL.mockImplementation((type: string) =>
      urlOf(type, canvas.width > 192 ? BIG : SMALL),
    );
    bitmap.width = 1000;
    bitmap.height = 1000;
    expect(await encoder.encode(png())).toBe(urlOf('image/webp', SMALL));
    expect([canvas.width, canvas.height]).toEqual([192, 192]);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(context.drawImage).toHaveBeenLastCalledWith(bitmap, 0, 0, 192, 192);
  });

  it('gives up with "size" below the limit at every size, and releases the bitmap', async () => {
    canvas.toDataURL.mockImplementation((type: string) => urlOf(type, BIG));
    await expect(encoder.encode(png())).rejects.toMatchObject({ problem: 'size' });
    expect(dataUrlBytes(urlOf('image/png', BIG))).toBeGreaterThan(AVATAR_MAX_BYTES);
    expect(context.drawImage).toHaveBeenCalledTimes(4);
    expect(canvas.toDataURL).toHaveBeenCalledTimes(16);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('accepts an image of exactly the limit', async () => {
    const exact = `${'A'.repeat(273_067)}=`;
    expect(dataUrlBytes(urlOf('image/webp', exact))).toBe(AVATAR_MAX_BYTES);
    canvas.toDataURL.mockImplementation((type: string) => urlOf(type, exact));
    expect(await encoder.encode(png())).toBe(urlOf('image/webp', exact));
  });
});
