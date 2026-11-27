import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeXml, parentElement, textElement, writeXml } from '../../src/invoice/xml-writer.ts';

describe('escapeXml', () => {
  it('escapes the five special characters', () => {
    assert.equal(escapeXml(`a & b < c > d "e" 'f'`), 'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
  });

  it('leaves everything else as it is, astral characters included', () => {
    assert.equal(escapeXml('Caffè 😀\t\n\r'), 'Caffè 😀\t\n\r');
  });

  it('refuses characters that XML 1.0 cannot hold', () => {
    for (const text of ['a\u0000b', 'a\u0008b', 'a\ud800b', 'a\ufffeb', 'a\uffffb']) {
      assert.throws(() => escapeXml(text), /not allowed in XML/, JSON.stringify(text));
    }
  });
});

describe('writeXml', () => {
  it('writes the declaration, indents, and escapes texts and attributes', () => {
    const xml = writeXml({
      name: 'root',
      attributes: { a: 'x"y', b: '1' },
      children: [parentElement('child', textElement('leaf', 'a&b')), textElement('other', 'ok')],
    });
    assert.equal(
      xml,
      '<?xml version="1.0" encoding="UTF-8"?>\n<root a="x&quot;y" b="1">\n  <child>\n    <leaf>a&amp;b</leaf>\n  </child>\n  <other>ok</other>\n</root>\n',
    );
  });

  it('never writes an empty element, however deep', () => {
    const xml = writeXml({
      name: 'root',
      children: [
        undefined,
        textElement('empty', ''),
        textElement('absent', undefined),
        { name: 'blank', text: '' },
        parentElement('emptyParent', undefined, parentElement('deeper', textElement('x', ''))),
        textElement('kept', '0'),
      ],
    });
    assert.equal(xml, '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <kept>0</kept>\n</root>\n');
  });

  it('is deterministic', () => {
    const tree = parentElement('r', textElement('a', '1'), textElement('b', '2'));
    assert.equal(writeXml(tree), writeXml(parentElement('r', textElement('a', '1'), textElement('b', '2'))));
  });

  it('refuses a document with nothing in it', () => {
    assert.throws(() => writeXml(parentElement('root', textElement('a', ''))), /empty/);
  });
});
