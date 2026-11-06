import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { mergeCompany } from '../../src/modules/dealers/dealer-rules.ts';
import { companyOf, fromDocument, minimalCompany, toNewDocument, toResponse } from '../../src/modules/dealers/dealer.mapper.ts';

const ADDRESS = { street: 'Via Roma 1', postcode: '00100', city: 'Roma', province: 'RM', countryCode: 'IT' };

describe('mergeCompany', () => {
  it('builds a new company from a request: absent fields are null, codes are upper case', () => {
    assert.deepEqual(mergeCompany(null, { businessName: 'Acme', vatNumber: '12345678901', fiscalCode: 'abcdef12g34h567i', sdiCode: 'abc1234' }), {
      ...minimalCompany('Acme'),
      vatNumber: '12345678901',
      fiscalCode: 'ABCDEF12G34H567I',
      sdiCode: 'ABC1234',
    });
  });

  it('accepts an Italian fiscal code of eleven digits', () => {
    assert.equal(mergeCompany(null, { businessName: 'Acme', fiscalCode: '12345678901' }).fiscalCode, '12345678901');
  });

  it('merges a partial address onto the stored one and keeps what is not mentioned', () => {
    const current = { ...minimalCompany('Acme'), address: ADDRESS };
    assert.deepEqual(mergeCompany(current, { address: { city: 'Milano' } }).address, { ...ADDRESS, city: 'Milano' });
    assert.deepEqual(mergeCompany(current, { address: { province: null, countryCode: 'fr' } }).address, { ...ADDRESS, province: null, countryCode: 'FR' });
    assert.equal(mergeCompany(current, { address: null }).address, null);
    assert.deepEqual(mergeCompany(current, { phone: '1' }).address, ADDRESS);
  });

  it('treats a company without an address as Italian and checks the province of an Italian address', () => {
    assert.throws(() => mergeCompany(null, { businessName: 'A', vatNumber: '123' }), { details: [{ field: 'vatNumber', issue: 'pattern' }] });
    assert.throws(() => mergeCompany(null, { businessName: 'A', address: { street: 's', postcode: 'p', city: 'c' } }, 'company.'), { details: [{ field: 'company.address.province', issue: 'required' }] });
    assert.throws(() => mergeCompany(null, { businessName: 'A', address: { street: 's', postcode: 'p', city: 'c', province: 'R1' } }), { details: [{ field: 'address.province', issue: 'pattern' }] });
  });

  it('applies the looser foreign rules outside Italy', () => {
    const foreign = { street: 's', postcode: 'p', city: 'c', countryCode: 'ES' };
    assert.equal(mergeCompany(null, { businessName: 'A', vatNumber: 'ESB12345678', address: foreign }).vatNumber, 'ESB12345678');
    assert.throws(() => mergeCompany(null, { businessName: 'A', vatNumber: 'E', address: foreign }), { details: [{ field: 'vatNumber', issue: 'pattern' }] });
  });

  it('lists every missing part of a new address', () => {
    assert.throws(() => mergeCompany(null, { businessName: 'A', address: {} }, 'company.'), {
      details: [
        { field: 'company.address.street', issue: 'required' },
        { field: 'company.address.postcode', issue: 'required' },
        { field: 'company.address.city', issue: 'required' },
      ],
    });
  });
});

describe('dealer mapper', () => {
  it('round-trips a document through the domain model and the response form', () => {
    const id = new ObjectId();
    const now = new Date('2026-11-06T10:00:00.000Z');
    const company = { ...minimalCompany('Acme'), address: ADDRESS, vatNumber: '12345678901' };
    const document = toNewDocument(id, company, 'manual', null, now);
    assert.deepEqual(Object.keys(document).sort(), ['_id', 'address', 'businessName', 'createdAt', 'createdBy', 'email', 'fiscalCode', 'pec', 'phone', 'sdiCode', 'source', 'updatedAt', 'vatNumber']);
    const dealer = fromDocument(document);
    assert.deepEqual(companyOf(dealer), company);
    assert.notEqual(companyOf(dealer).address, company.address);
    assert.deepEqual(toResponse(dealer, null), { id: id.toHexString(), ...company, source: 'manual', createdAt: now.toISOString(), updatedAt: now.toISOString(), user: null });
  });
});
