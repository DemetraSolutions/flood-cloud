import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../../src/shared/xlsx/xml.ts';

/** The events of a document as a list of strings. */
function events(source: string, depth = 32): string[] {
  const log: string[] = [];
  parseXml(
    source,
    {
      open: (name, attributes) => log.push(`<${name}${[...attributes].map(([key, value]) => ` ${key}=${value}`).join('')}`),
      close: (name) => log.push(`</${name}`),
      text: (value) => log.push(`#${value}`),
    },
    depth,
  );
  return log;
}
const refused = (reason: string) => ({ name: 'XlsxError', reason });

describe('XML tokenizer', () => {
  it('reports elements, attributes (single or double quoted), text, CDATA, comments and the declaration', () => {
    const log = events('﻿<?xml version="1.0"?><!-- note --><a:r xmlns:a="u" b=\'1\' a:c="2"><x>t&amp;&lt;&gt;&quot;&apos;&#65;&#x42;</x><![CDATA[<raw>]]><e/></a:r>\n');
    assert.deepEqual(log, ['<r a=u b=1 c=2', '<x', '#t&<>"\'AB', '</x', '#<raw>', '<e', '</e', '</r']);
  });

  it('reports the text between elements and ignores what is after the root', () => {
    assert.deepEqual(events('<a> <b/> tail</a>\n<!-- end -->'), ['<a', '# ', '<b', '</b', '# tail', '</a']);
    assert.deepEqual(events('<a>plain</a>'), ['<a', '#plain', '</a']);
  });

  it('refuses every markup declaration: no DOCTYPE, no entity is ever defined', () => {
    assert.throws(() => events('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'), refused('unsafe'));
    assert.throws(() => events('<a><!ENTITY x "y"></a>'), refused('unsafe'));
    assert.throws(() => events('<?xml version="1.0"?>\n<!doctype html><a/>'), refused('unsafe'));
  });

  it('refuses references other than the predefined and numeric ones', () => {
    for (const text of ['&x;', '&', 'a & b', '&#0;', '&#xD800;', '&#1114112;', '&#x;', '&amp']) {
      assert.throws(() => events(`<a>${text}</a>`), refused('malformed'), text);
    }
    assert.throws(() => events('<a b="&x;"/>'), refused('malformed'));
  });

  it('refuses a document that is not well formed', () => {
    const bad = ['', '   ', 'text', '<a>', '<a></b>', '</a>', '<a/><b/>', '<a><', '< a/>', '<a b=1/>', '<a b="1" b="2"/>', '<a b="1"', '<a b="<"/>', '<a><!-- open</a>', '<a><![CDATA[open</a>', '<?xml open', '<a>x</a>tail', '<![CDATA[x]]><a/>', '<a></a', '<a b="1"c="2"/>'];
    for (const source of bad) {
      assert.throws(() => events(source), refused('malformed'), source);
    }
  });

  it('refuses a document nested deeper than the limit', () => {
    assert.throws(() => events('<a><a><a><a/></a></a></a>', 3), refused('limit'));
    assert.equal(events('<a><a><a/></a></a>', 3).length, 6);
  });
});
