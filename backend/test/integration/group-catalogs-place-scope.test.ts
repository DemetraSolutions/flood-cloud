import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ObjectId } from 'mongodb';
import { openCatalogOffice } from '../helpers/catalogs.ts';
import type { CatalogOffice } from '../helpers/catalogs.ts';

let t: CatalogOffice;
before(async () => {
  t = await openCatalogOffice();
});
after(async () => {
  await t.close();
});

const own = () => t.group(0).ownPlaceId.toHexString();
const other = () => t.group(0).otherPlaceId.toHexString();
const forbidden = (...details: Array<[string, string]>) => ({ status: 403, code: 'FORBIDDEN', details: details.length === 0 ? undefined : details.map(([field, issue]) => ({ field, issue })) });

/** The two catalogs whose elements apply to some places, with the body that names the places and the field of the error. */
const CATALOGS = [
  { segment: '/fidelity/card-types', field: 'placeIds', body: (places?: string[]) => ({ name: 'Carta', ...(places === undefined ? {} : { placeIds: places }) }) },
  {
    segment: '/promotions',
    field: 'conditions.placeIds',
    body: (places?: string[]) => ({ name: 'Promo', ...(places === undefined ? {} : { conditions: { placeIds: places } }) }),
  },
] as const;

describe('a company or place administrator writes only the elements of the places of his scope', () => {
  const actors = (): Array<[string, ObjectId]> => [
    ['CA', t.group(0).ca],
    ['PA', t.group(0).pa],
  ];
  const call = (actor: ObjectId, method: string, rest: string, body?: unknown) => t.as.call(actor, method, t.path(0, rest), body);

  for (const catalog of CATALOGS) {
    it(`${catalog.segment}: creates and changes elements of his places, refuses other places and the empty list (every place)`, async () => {
      for (const [role, actor] of actors()) {
        const created = await call(actor, 'POST', catalog.segment, catalog.body([own()]));
        assert.equal(created.status, 201, `${role} ${JSON.stringify(created.body)}`);
        const id = created.body.data.id as string;
        assert.deepEqual(t.as.failure(await call(actor, 'POST', catalog.segment, catalog.body())), forbidden([catalog.field, 'notAllowed']), role);
        assert.deepEqual(t.as.failure(await call(actor, 'POST', catalog.segment, catalog.body([]))), forbidden([catalog.field, 'notAllowed']), role);
        assert.deepEqual(t.as.failure(await call(actor, 'POST', catalog.segment, catalog.body([own(), other()]))), forbidden([`${catalog.field}.1`, 'notAllowed']), role);
        // Widening an element of his own to every place, or to another place, is refused as well.
        assert.deepEqual(t.as.failure(await call(actor, 'PATCH', `${catalog.segment}/${id}`, catalog.body([]))), forbidden([catalog.field, 'notAllowed']), role);
        assert.deepEqual(t.as.failure(await call(actor, 'PATCH', `${catalog.segment}/${id}`, catalog.body([other()]))), forbidden([`${catalog.field}.0`, 'notAllowed']), role);
        assert.equal((await call(actor, 'PATCH', `${catalog.segment}/${id}`, { name: 'Rinominata' })).status, 200, role);
        assert.equal((await call(actor, 'DELETE', `${catalog.segment}/${id}`)).status, 204, role);
      }
    });

    it(`${catalog.segment}: reads but cannot change or delete the elements of other places or of every place`, async () => {
      const sa = t.group(0).sa;
      const ids: string[] = [];
      for (const places of [[other()], [own(), other()], []]) {
        const reply = await call(sa, 'POST', catalog.segment, catalog.body(places));
        assert.equal(reply.status, 201, JSON.stringify(reply.body));
        ids.push(reply.body.data.id as string);
      }
      const before = await t.stored(0);
      for (const [role, actor] of actors()) {
        const listed = (await call(actor, 'GET', catalog.segment)).body.data as Array<{ id: string }>;
        assert.equal(ids.every((id) => listed.some((element) => element.id === id)), true, role);
        for (const id of ids) {
          assert.deepEqual(t.as.failure(await call(actor, 'PATCH', `${catalog.segment}/${id}`, { name: 'Presa' })), forbidden(), `${role} ${id}`);
          // Even a request that would only narrow it to his places.
          assert.deepEqual(t.as.failure(await call(actor, 'PATCH', `${catalog.segment}/${id}`, catalog.body([own()]))), forbidden(), `${role} ${id}`);
          assert.deepEqual(t.as.failure(await call(actor, 'DELETE', `${catalog.segment}/${id}`)), forbidden(), `${role} ${id}`);
        }
      }
      assert.deepEqual(await t.stored(0), before);
      // The group administrator is not limited to places.
      for (const id of ids) {
        assert.equal((await call(sa, 'PATCH', `${catalog.segment}/${id}`, catalog.body([]))).status, 200);
        assert.equal((await call(sa, 'DELETE', `${catalog.segment}/${id}`)).status, 204);
      }
    });
  }

  it('does not limit the catalogs without places', async () => {
    const created = await call(t.group(0).ca, 'POST', '/product-favorites', { name: 'Preferiti del CA' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await call(t.group(0).pa, 'DELETE', `/product-favorites/${created.body.data.id as string}`)).status, 204);
  });
});
