import { backend, errorBody, settle } from '../../../testing/api';
import {
  BASE,
  CONTACT,
  EDIT,
  GROUP,
  ID,
  ITEM,
  L,
  NEW,
  NO_FEATURES,
  OTHER_ID,
  SERVICE,
  ContactView,
  renderContact,
} from '../../../testing/contacts-page';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

const CREATED = { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } };

/** Answers the reads of the page of the contact the creation opened. */
const opened = (view: ContactView) => view.answer({ edit: true });

/** Fills what a new contact needs and sends it. */
async function fillNew(view: ContactView) {
  await view.type(L.firstName, '  Anna ');
  await view.type(L.lastName, 'Neri');
}

describe('ContactPage: creating a contact', () => {
  it('sends the whole form with an Idempotency-Key and opens the page of the contact', async () => {
    const view = await renderContact(NEW);
    await fillNew(view);
    await view.type(L.code, ' K9 ');
    expect(view.save()!.disabled).toBe(false);
    await view.submit();

    const req = backend().expectOne(BASE);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.request.headers.has('If-Match')).toBe(false);
    expect(req.request.body).toEqual({
      code: 'K9',
      customer: true,
      supplier: false,
      contactGroupId: null,
      priceListId: null,
      notes: null,
      person: {
        firstName: 'Anna',
        lastName: 'Neri',
        taxCode: '',
        birthDate: null,
        address: { street: '', postcode: '', city: '', countryCode: null, areaCode: null },
        phones: [],
        emails: [],
        discountPercent: null,
        associatedCompanyId: null,
      },
      company: {
        name: '',
        vatNumber: '',
        taxCode: '',
        address: { street: '', postcode: '', city: '', countryCode: null, areaCode: null },
        phones: [],
        emails: [],
        faxes: [],
        discountPercent: null,
        supplierPriceLists: [],
      },
      eInvoicing: {
        transmissionFormat: 'FPR12',
        channel: 'CD',
        recipientCode: null,
        pec: null,
        paymentTerms: null,
        paymentMethod: null,
        taxRegime: null,
        administrationReference: null,
        splitPayment: false,
        requirePurchaseOrderData: false,
      },
      account: { email: null, phone: null },
      fidelityCards: [],
      services: [],
    });
    req.flush({ data: CONTACT }, CREATED);
    await opened(view);

    expect(view.toasts()).toEqual(['success: CONTACTS.FORM.CREATED']);
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'customers');
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'suppliers');
    expect(view.router.url).toBe(`/groups/${GROUP}/contacts/${ID}`);
  });

  it('shows the page of the contact it created, read from the server', async () => {
    const view = await renderContact(NEW);
    await fillNew(view);
    await view.submit();
    backend()
      .expectOne(BASE)
      .flush({ data: { ...CONTACT, id: ID } }, CREATED);
    await view.view();
    await view.answer({ edit: true });
    expect(view.heading()).toBe('Verdi srl');
    expect(view.control(L.firstName).value).toBe('Luca');
  });

  it('leaves the services out of the body in a group without the feature', async () => {
    const view = await renderContact(NEW, { features: NO_FEATURES });
    await fillNew(view);
    await view.submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).not.toHaveProperty('services');
    req.flush({ data: CONTACT }, CREATED);
    await opened(view);
  });

  it('sends a supplier that is opened from the suppliers tab', async () => {
    const view = await renderContact(`${NEW}?kind=suppliers`);
    await view.type(L.companyName, 'Fornitore srl');
    await view.submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toEqual(
      expect.objectContaining({
        customer: false,
        supplier: true,
        company: expect.objectContaining({ name: 'Fornitore srl' }),
      }),
    );
    req.flush({ data: CONTACT }, CREATED);
    await opened(view);
  });

  it('sends the cards as codes, the services and the lists without the empty entries', async () => {
    const view = await renderContact(NEW);
    await fillNew(view);
    await view.setModel((model) => ({
      ...model,
      cards: [' CARD9 ', ''],
      services: [{ productId: SERVICE, duration: '01:00' }],
      person: { ...model.person, emails: ['anna@example.com', '  '] },
      company: {
        ...model.company,
        supplierPriceLists: [{ id: '', name: ' Listino ', favorite: true }],
      },
    }));
    await view.submit();
    const req = backend().expectOne(BASE);
    expect(req.request.body).toEqual(
      expect.objectContaining({
        fidelityCards: [{ code: 'CARD9' }],
        services: [{ productId: SERVICE, duration: '01:00' }],
        person: expect.objectContaining({ emails: ['anna@example.com'] }),
        company: expect.objectContaining({
          supplierPriceLists: [{ name: 'Listino', favorite: true }],
        }),
      }),
    );
    req.flush({ data: CONTACT }, CREATED);
    await opened(view);
  });

  it('shows the button as busy while the request is on its way', async () => {
    const view = await renderContact(NEW);
    await fillNew(view);
    await view.submit();
    expect(view.save()!.getAttribute('aria-busy')).toBe('true');
    expect(view.save()!.disabled).toBe(true);
    backend().expectOne(BASE).flush({ data: CONTACT }, CREATED);
    await opened(view);
  });

  it('reuses the Idempotency-Key in a new attempt with the same body', async () => {
    const view = await renderContact(NEW);
    await fillNew(view);
    await view.submit();
    const first = backend().expectOne(BASE);
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view.view();
    expect(view.formError()).toContain('ERRORS.API.INTERNAL_ERROR');

    await view.submit();
    const second = backend().expectOne(BASE);
    expect(second.request.headers.get('Idempotency-Key')).toBe(key);
    expect(view.formError()).toBeNull();
    second.flush({ data: CONTACT }, CREATED);
    await opened(view);
  });

  it('uses a new Idempotency-Key when the body changed after a failed attempt', async () => {
    const view = await renderContact(NEW);
    await fillNew(view);
    await view.submit();
    const first = backend().expectOne(BASE);
    const key = first.request.headers.get('Idempotency-Key');
    first.flush(errorBody('INTERNAL_ERROR'), { status: 500, statusText: 'x' });
    await view.view();

    await view.type(L.lastName, 'Bianchi');
    await view.submit();
    const second = backend().expectOne(BASE);
    expect(second.request.headers.get('Idempotency-Key')).not.toBe(key);
    expect(second.request.body).toEqual(
      expect.objectContaining({ person: expect.objectContaining({ lastName: 'Bianchi' }) }),
    );
    second.flush({ data: CONTACT }, CREATED);
    await opened(view);
  });

  it('does not send a new contact without a name', async () => {
    const view = await renderContact(NEW);
    expect(view.save()!.disabled).toBe(true);
    await view.submit();
    backend().expectNone(BASE);
  });
});

describe('ContactPage: changing a contact', () => {
  it('sends only the changed field with the version read in If-Match, and shows the answer', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.code, ' K2 ');
    expect(view.save()!.disabled).toBe(false);
    await view.submit();

    const req = backend().expectOne(ITEM);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.headers.get('If-Match')).toBe('"v1"');
    expect(req.request.headers.has('Idempotency-Key')).toBe(false);
    expect(req.request.body).toEqual({ code: 'K2' });
    req.flush({ data: { ...CONTACT, code: 'K2' } }, { headers: { ETag: '"v2"' } });
    await view.view();

    expect(view.toasts()).toEqual(['success: CONTACTS.FORM.SAVED']);
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'customers');
    expect(view.referenceStore.invalidate).toHaveBeenCalledWith(GROUP, 'suppliers');
    expect(view.router.url).toBe(EDIT);
    expect(view.save()!.disabled).toBe(true);
    expect(view.control(L.code).value).toBe('K2');

    // The next save presents the new version.
    await view.type(L.code, 'K3');
    await view.submit();
    const next = backend().expectOne(ITEM);
    expect(next.request.headers.get('If-Match')).toBe('"v2"');
    expect(next.request.body).toEqual({ code: 'K3' });
    next.flush({ data: { ...CONTACT, code: 'K3' } }, { headers: { ETag: '"v3"' } });
    await view.view();
  });

  it('sends the nested objects field by field', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.firstName, 'Marco');
    await view.type(L.recipientCode, 'XYZ9876');
    await view.type(L.accountEmail, 'marco@example.com');
    await view.submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.body).toEqual({
      person: { firstName: 'Marco' },
      eInvoicing: { recipientCode: 'XYZ9876' },
      account: { email: 'marco@example.com' },
    });
    req.flush({ data: CONTACT });
    await view.view();
  });

  it('sends a list that changed whole and an emptied field as null', async () => {
    const view = await renderContact(EDIT);
    await view.setModel((model) => ({
      ...model,
      notes: '',
      person: { ...model.person, emails: ['luca.verdi@example.com', 'luca@example.org'] },
    }));
    await view.submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.body).toEqual({
      notes: null,
      person: { emails: ['luca.verdi@example.com', 'luca@example.org'] },
    });
    req.flush({ data: CONTACT });
    await view.view();
  });

  it('sends the cards as codes only and the changed services', async () => {
    const view = await renderContact(EDIT);
    await view.setModel((model) => ({
      ...model,
      cards: ['CARD1', 'CARD2'],
      services: [{ productId: SERVICE, duration: '00:45' }],
    }));
    await view.submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.body).toEqual({
      fidelityCards: [{ code: 'CARD1' }, { code: 'CARD2' }],
      services: [{ productId: SERVICE, duration: '00:45' }],
    });
    req.flush({ data: CONTACT });
    await view.view();
  });

  it('sends the price lists of the supplier with the ids of the ones that were already there', async () => {
    const view = await renderContact(EDIT);
    await view.setModel((model) => ({
      ...model,
      company: {
        ...model.company,
        supplierPriceLists: [
          { ...model.company.supplierPriceLists[0], name: 'Listino A2' },
          { id: '', name: 'Nuovo', favorite: false },
        ],
      },
    }));
    await view.submit();
    const req = backend().expectOne(ITEM);
    expect((req.request.body as { company: object }).company).toEqual({
      supplierPriceLists: [
        { id: expect.any(String), name: 'Listino A2', favorite: true },
        { name: 'Nuovo', favorite: false },
      ],
    });
    req.flush({ data: CONTACT });
    await view.view();
  });

  it('keeps the save button disabled while the form equals the saved contact, and again after a change is undone', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.code, 'K2');
    expect(view.save()!.disabled).toBe(false);
    await view.type(L.code, 'K1');
    expect(view.save()!.disabled).toBe(true);
  });

  it('shows the warnings of duplicates the save answers with', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.code, 'K2');
    await view.submit();
    backend()
      .expectOne(ITEM)
      .flush({
        data: {
          ...CONTACT,
          code: 'K2',
          warnings: [{ field: 'code', issue: 'duplicate', contactIds: [OTHER_ID], others: 0 }],
        },
      });
    await view.view();
    await view.answer({ rows: [{ id: OTHER_ID, displayName: 'Anna Neri' }] });
    expect(view.el().querySelector('fc-contact-warning-note a')?.textContent).toBe('Anna Neri');
    expect(
      view.el().querySelector('fc-contact-warning-note p[role=status]')?.textContent,
    ).toContain('CONTACTS.WARNING.DUPLICATE');
    expect(view.toasts()).toEqual(['success: CONTACTS.FORM.SAVED']);
  });

  it('sends the version as absent when the server answered without one', async () => {
    const view = await renderContact(EDIT);
    await view.type(L.code, 'K2');
    await view.submit();
    backend()
      .expectOne(ITEM)
      .flush({ data: { ...CONTACT, code: 'K2' } });
    await view.view();
    await view.type(L.code, 'K4');
    await view.submit();
    const req = backend().expectOne(ITEM);
    expect(req.request.headers.has('If-Match')).toBe(false);
    req.flush({ data: { ...CONTACT, code: 'K4' } });
    await view.view();
    await settle();
  });
});
