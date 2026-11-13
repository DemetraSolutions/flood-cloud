import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_FORMATS, MAX_SLUG_LENGTH, MAX_TITLE_LENGTH, detectImageFormat, slugOf, titleOf } from '../../src/modules/media/image-format.ts';
import { IMAGE_SIZES, IMAGE_SIZE_NAMES } from '../../src/modules/media/image.types.ts';
import { MAX_INPUT_PIXELS, MAX_SIDE, processImage } from '../../src/modules/media/image-processing.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { GIF, PNG_POLYGLOT, SVG, animatedWebp, describeImage, hugePng, image, rotatedJpeg } from '../helpers/images.ts';

const incorrect = (error: unknown): boolean => error instanceof AppError && error.code === 'VALIDATION_ERROR' && JSON.stringify(error.details) === JSON.stringify([{ field: 'file', issue: 'incorrect' }]);

describe('image format by magic bytes', () => {
  it('recognizes JPEG, PNG and WebP from their first bytes, whatever they are called', async () => {
    assert.equal(detectImageFormat(await image('jpeg')), 'jpeg');
    assert.equal(detectImageFormat(await image('png')), 'png');
    assert.equal(detectImageFormat(await image('webp')), 'webp');
    assert.deepEqual(IMAGE_FORMATS.jpeg, { extension: 'jpg', mimetype: 'image/jpeg' });
    assert.deepEqual(IMAGE_FORMATS.png, { extension: 'png', mimetype: 'image/png' });
    assert.deepEqual(IMAGE_FORMATS.webp, { extension: 'webp', mimetype: 'image/webp' });
  });

  it('refuses everything else, truncated signatures included', () => {
    for (const bytes of [GIF, SVG, Buffer.from('<html></html>'), Buffer.alloc(0), Buffer.from([0xff, 0xd8]), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('RIFF....WAVE'), Buffer.from('RIFF....WEB'), Buffer.from('%PDF-1.7')]) {
      assert.equal(detectImageFormat(bytes), null);
    }
    assert.equal(detectImageFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
    assert.equal(detectImageFormat(PNG_POLYGLOT), 'png', 'the signature decides; the decoder refuses the rest');
  });
});

describe('names', () => {
  it('builds the slug from the name without its extension: no accents, lower case, runs of letters and digits joined by dashes', () => {
    assert.equal(slugOf('Logo Bar.PNG'), 'logo-bar');
    assert.equal(slugOf('Caffè Società Ünï.jpeg'), 'caffe-societa-uni');
    assert.equal(slugOf('foto.v2.final.JPG'), 'foto-v2-final');
    assert.equal(slugOf('../../etc/pass wd.png'), 'etc-pass-wd');
    assert.equal(slugOf('logo'), 'logo');
    assert.equal(slugOf('  --  .png'), 'image');
    assert.equal(slugOf('.png'), 'image');
    assert.equal(slugOf('日本語.png'), 'image');
    assert.equal(slugOf('ＦＵＬＬ-ｗｉｄｔｈ.png'), 'full-width');
  });

  it('cuts the slug at 60 characters without leaving a trailing dash', () => {
    const long = `${'a'.repeat(59)} bbb.png`;
    assert.equal(slugOf(long), 'a'.repeat(59));
    assert.equal(slugOf(`${'word '.repeat(40)}.png`).length <= MAX_SLUG_LENGTH, true);
    assert.equal(slugOf('x'.repeat(100)), 'x'.repeat(60));
  });

  it('builds the title from the name: trimmed, without control characters, at most 150 characters, the slug when nothing is left', () => {
    assert.equal(titleOf('  Logo\u0000 Bar\u0085.png', 'logo-bar'), 'Logo Bar');
    assert.equal(titleOf('Caffè.png', 'caffe'), 'Caffè');
    assert.equal(titleOf('\u0001\u0002.png', 'image'), 'image');
    assert.equal(titleOf('   .png', 'image'), 'image');
    const long = titleOf(`${'é'.repeat(200)}.png`, 'x');
    assert.equal([...long].length, MAX_TITLE_LENGTH);
    assert.equal(titleOf(`${'😀'.repeat(200)}.png`, 'x').length, MAX_TITLE_LENGTH * 2, 'cut on a character, never in the middle of a pair');
    assert.equal(titleOf(`${'a'.repeat(149)} b.png`, 'x'), 'a'.repeat(149));
    // Format characters (right-to-left override, zero width), line separators and the characters of HTML are removed.
    assert.equal(titleOf('a\u202Eb\u200Bc\u2028d\u2029e<script>"x".png', 'x'), 'abcdescriptx');
    assert.equal(titleOf('<>\u202E.png', 'fallback'), 'fallback');
  });
});

describe('image processing', () => {
  it('makes the five sizes at the legacy widths, never larger than the original, in the same format', async () => {
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const sizes = await processImage(await image(format, 1500, 750), format);
      assert.deepEqual(Object.keys(sizes), [...IMAGE_SIZE_NAMES]);
      for (const size of IMAGE_SIZE_NAMES) {
        const described = await describeImage(sizes[size]);
        assert.equal(described.format, format);
        assert.equal(described.width, IMAGE_SIZES[size]);
        assert.equal(described.height, IMAGE_SIZES[size] / 2);
      }
    }
    assert.deepEqual(IMAGE_SIZES, { xs: 100, s: 250, m: 500, l: 800, xl: 1200 });
  });

  it('does not enlarge a small image: every size has the original width', async () => {
    const sizes = await processImage(await image('png', 64, 32), 'png');
    for (const size of IMAGE_SIZE_NAMES) {
      assert.equal((await describeImage(sizes[size])).width, size === 'xs' ? 64 : 64);
    }
    const mixed = await processImage(await image('jpeg', 300, 100), 'jpeg');
    assert.deepEqual(await Promise.all(IMAGE_SIZE_NAMES.map(async (size) => (await describeImage(mixed[size])).width)), [100, 250, 300, 300, 300]);
  });

  it('keeps the transparency of a PNG', async () => {
    const sizes = await processImage(await image('png', 400, 400, { alpha: true }), 'png');
    assert.equal((await describeImage(sizes.s)).hasAlpha, true);
  });

  it('turns an image upright by its EXIF orientation and strips every metadata', async () => {
    const source = await rotatedJpeg();
    assert.equal((await describeImage(source)).hasExif, true);
    const sizes = await processImage(source, 'jpeg');
    for (const size of IMAGE_SIZE_NAMES) {
      const described = await describeImage(sizes[size]);
      assert.equal(described.hasExif, false);
      assert.equal(described.orientation, undefined);
      assert.equal(sizes[size].includes(Buffer.from('secret-copyright')), false);
    }
    assert.deepEqual(await describeImage(sizes.xl), { width: 40, height: 80, format: 'jpeg', hasExif: false, hasAlpha: false, orientation: undefined });
  });

  it('refuses what cannot be an image: a damaged file, a polyglot, a truncated image', async () => {
    const good = await image('jpeg', 200, 200);
    for (const [bytes, format] of [
      [PNG_POLYGLOT, 'png'],
      [good.subarray(0, 40), 'jpeg'],
      [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('garbage')]), 'jpeg'],
      [Buffer.from('RIFF\0\0\0\0WEBPgarbage'), 'webp'],
    ] as const) {
      await assert.rejects(() => processImage(bytes, format), incorrect);
    }
  });

  it('refuses an image with more than 40 megapixels and an animated WebP', async () => {
    assert.equal(MAX_INPUT_PIXELS, 40_000_000);
    const huge = await hugePng();
    const animated = await animatedWebp();
    await assert.rejects(() => processImage(huge, 'png'), incorrect);
    await assert.rejects(() => processImage(animated, 'webp'), incorrect);
  });

  it('refuses an image with a side longer than 16383 pixels, however few pixels it has, and an image that is damaged only at its end', async () => {
    assert.equal(MAX_SIDE, 16_383);
    const tall = await image('png', 100, 16_384);
    await assert.rejects(() => processImage(tall, 'png'), incorrect);
    const wide = await image('png', 16_384, 100);
    await assert.rejects(() => processImage(wide, 'png'), incorrect);
    const edge = await processImage(await image('png', 100, 16_383), 'png');
    assert.equal((await describeImage(edge.xl)).height, 16_383);
    // A truncated file decodes with a warning of the decoder; the strictest level of sharp (the default) makes it an error.
    const good = await image('jpeg', 400, 400);
    await assert.rejects(() => processImage(good.subarray(0, good.length - 30), 'jpeg'), incorrect);
  });

  it('decodes once and makes the smaller sizes from the xl one: the sizes keep the proportions', async () => {
    const sizes = await processImage(await image('webp', 3000, 1000), 'webp');
    assert.deepEqual(await Promise.all(IMAGE_SIZE_NAMES.map(async (size) => (await describeImage(sizes[size])).height)), [33, 83, 167, 267, 400]);
  });

  it('accepts an image just under the limit', async () => {
    const sizes = await processImage(await image('png', 6000, 6000), 'png');
    assert.equal((await describeImage(sizes.xl)).width, 1200);
  });
});
