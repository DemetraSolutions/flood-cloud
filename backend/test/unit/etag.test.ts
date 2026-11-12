import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { canonicalJson, etagOf, sendRevalidated } from '../../src/shared/http/etag.ts';

function exchange(ifNoneMatch?: string) {
  const headers = new Map<string, string>();
  const sent: { status?: number; body?: unknown; ended?: boolean } = {};
  const res = {
    setHeader: (name: string, value: string) => void headers.set(name, value),
    status: (code: number) => {
      sent.status = code;
      return res;
    },
    json: (body: unknown) => void (sent.body = body),
    end: () => void (sent.ended = true),
  } as unknown as Response;
  const req = { get: (name: string) => (name === 'if-none-match' ? ifNoneMatch : undefined) } as unknown as Request;
  return { req, res, headers, sent };
}

describe('canonical JSON and entity tags', () => {
  it('orders keys at every depth and skips undefined values', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: null, y: 'x' }], c: undefined } }), '{"a":{"d":[2,{"y":"x","z":null}]},"b":1}');
    assert.equal(canonicalJson('t'), '"t"');
  });

  it('gives the same weak tag to the same content whatever the order of the keys, and another to different content', () => {
    const tag = etagOf({ a: 1, b: [1, 2] });
    assert.match(tag, /^W\/"[A-Za-z0-9_-]{43}"$/);
    assert.equal(etagOf({ b: [1, 2], a: 1 }), tag);
    assert.notEqual(etagOf({ a: 1, b: [2, 1] }), tag);
  });
});

describe('sendRevalidated', () => {
  const data = { id: 'x' };
  const tag = etagOf(data);

  it('sends the data with the tag and a revalidation cache policy when there is no condition', () => {
    const { req, res, headers, sent } = exchange();
    sendRevalidated(req, res, data);
    assert.deepEqual([headers.get('ETag'), headers.get('Cache-Control'), sent.status, sent.body], [tag, 'no-store', 200, { data }]);
  });

  it('answers 304 without a body to a matching If-None-Match: the tag, its strong form, a list containing it, or *', () => {
    for (const header of [tag, tag.slice(2), `"other", ${tag}`, '*', `  ${tag}  `]) {
      const { req, res, headers, sent } = exchange(header);
      sendRevalidated(req, res, data);
      assert.deepEqual([sent.status, sent.ended, sent.body, headers.get('ETag')], [304, true, undefined, tag], header);
    }
  });

  it('sends the data again when the tag does not match', () => {
    const { req, res, sent } = exchange('W/"stale"');
    sendRevalidated(req, res, data);
    assert.equal(sent.status, 200);
  });
});
