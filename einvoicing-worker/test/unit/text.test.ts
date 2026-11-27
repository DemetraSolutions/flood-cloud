import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanText, identifier, splitText } from '../../src/invoice/text.ts';

describe('cleanText', () => {
  it('replaces typographic characters with ASCII equivalents', () => {
    const result = cleanText('Caffè “speciale” – l’uno ‘due’ — 2€ …', 'basic', 100);
    assert.equal(result.value, 'Caffe "speciale" - l\'uno \'due\' - 2EUR ...');
    assert.equal(result.replaced, false);
    assert.equal(result.truncated, false);
  });

  it('keeps accents, punctuation and ampersands in Latin fields', () => {
    assert.equal(cleanText("Perché è già così: a&b - d'Angelo (x) «y» ñ", 'latin').value, "Perché è già così: a&b - d'Angelo (x) «y» ñ");
  });

  it('transliterates accents in Basic Latin fields', () => {
    assert.equal(cleanText('àèéìòù ÀÉ ñ ü ç ß æ Æ ø Ø Œ œ Ł ł Đ đ Ð ð Þ þ', 'basic').value, 'aeeiou AE n u c ss ae AE o O OE oe L l D d D d TH th');
  });

  it('transliterates letters outside Latin-1 even in Latin fields', () => {
    assert.equal(cleanText('Škoda ő ł', 'latin').value, 'Skoda o l');
  });

  it('composes decomposed accents before looking at them', () => {
    assert.equal(cleanText('é', 'latin').value, 'é');
    assert.equal(cleanText('é', 'basic').value, 'e');
  });

  it('collapses tabs, line breaks and every kind of space to one space and trims', () => {
    assert.equal(cleanText('  a\tb\r\nc d   e f \n', 'latin').value, 'a b c d e f');
  });

  it('removes invisible characters', () => {
    assert.equal(cleanText('a​b⁠c', 'latin').value, 'abc');
  });

  it('turns what has no representation into ? and says so', () => {
    for (const text of ['x😀y', 'x漢y', 'x\u0000y', 'x\u0085y', 'x\u007fy', 'x́']) {
      const result = cleanText(text, 'latin');
      assert.equal(result.replaced, true, JSON.stringify(text));
      assert.match(result.value, /\?/);
    }
    assert.equal(cleanText('😀', 'latin').value, '?');
    assert.equal(cleanText('x😀y', 'latin').value, 'x?y');
  });

  it('cuts at the maximum length, never leaving a trailing space, and says so', () => {
    const result = cleanText('abc def ghi', 'latin', 4);
    assert.equal(result.value, 'abc');
    assert.equal(result.truncated, true);
    assert.equal(cleanText('abcdef', 'latin', 6).truncated, false);
  });

  it('never splits an emoji: every character is a single unit after cleaning', () => {
    const result = cleanText('😀😀😀😀', 'latin', 3);
    assert.equal(result.value, '???');
    assert.equal(result.truncated, true);
  });

  it('returns an empty value for an empty or blank text', () => {
    assert.equal(cleanText('  \n ', 'latin').value, '');
  });
});

describe('splitText', () => {
  it('returns nothing for an empty text and one block for a short one', () => {
    assert.deepEqual(splitText('', 10), []);
    assert.deepEqual(splitText('short text', 10), ['short text']);
  });

  it('cuts at spaces and loses no word', () => {
    const blocks = splitText('aaa bbb ccc ddd eee', 8);
    assert.deepEqual(blocks, ['aaa bbb', 'ccc ddd', 'eee']);
    assert.ok(blocks.every((block) => block.length <= 8));
  });

  it('uses a space right at the limit and cuts a long word in the middle', () => {
    assert.deepEqual(splitText('abcd efgh', 4), ['abcd', 'efgh']);
    assert.deepEqual(splitText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  });
});

describe('identifier', () => {
  it('returns a clean identifier as it is, without surrounding spaces', () => {
    assert.equal(identifier('  AB-12/3 ', 20), 'AB-12/3');
  });

  it('never alters a value: anything wrong is null', () => {
    assert.equal(identifier('', 5), null);
    assert.equal(identifier('   ', 5), null);
    assert.equal(identifier('abcdef', 5), null);
    assert.equal(identifier('àb', 5), null);
    assert.equal(identifier('a\nb', 5), null);
    assert.equal(identifier('€', 5), null);
  });
});
