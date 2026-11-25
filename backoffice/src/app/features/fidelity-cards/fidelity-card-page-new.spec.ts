import { By } from '@angular/platform-browser';
import { backend } from '../../../testing/api';
import {
  BASE,
  CONTACT_A,
  CONTACT_B,
  GROUP,
  L,
  LIST_ROUTE,
  NEW,
  NEW_ID,
  NO_CONTACTS,
  READ_ONLY,
  aCard,
  renderCard,
} from '../../../testing/fidelity-card-page';
import { SearchCombobox } from '../../shared/ui/search-combobox/search-combobox';
import { FIDELITY_CARD_LIMITS } from './fidelity-card.types';

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

/** Chooses a type in the select of the type. */
async function chooseType(view: Awaited<ReturnType<typeof renderCard>>, id: string) {
  await view.type(L.type, id);
}

describe('FidelityCardPage: a new card', () => {
  it('opens the empty form with its title, the creation button disabled and nothing else', async () => {
    const view = await renderCard(NEW);
    expect(view.heading()).toBe('FIDELITY_CARDS.FORM.NEW_TITLE');
    expect(view.save()!.textContent).toContain('FIDELITY_CARDS.FORM.CREATE');
    expect(view.save()!.disabled).toBe(true);
    expect(view.el().querySelector('.meta')).toBeNull();
    expect(view.button('FIDELITY_CARDS.DELETE.ACTION')).toBeUndefined();
    expect(view.el().querySelector('a[href]')?.getAttribute('href')).toBe(LIST_ROUTE);
    expect((view.control(L.enabled) as HTMLInputElement).checked).toBe(true);
    expect(view.control(L.code).value).toBe('');
    expect((view.control(L.type) as HTMLSelectElement).value).toBe('');
    expect(view.text()).not.toContain('FIDELITY_CARDS.BALANCES.TITLE');
    expect(view.text()).not.toContain('FIDELITY_CARDS.CUSTOMERS.TITLE');
    expect(view.text()).not.toContain('FIDELITY_CARDS.FIELD.INITIAL_BALANCE');
    expect(view.text()).not.toContain('FIDELITY_CARDS.FIELD.INITIAL_POINTS');
    expect(view.text()).toContain('FIDELITY_CARDS.FIELD.CUSTOMERS_HINT {"max":20}');
    backend().expectNone(`${BASE}/${NEW_ID}`);
  });

  it('enables the creation button as soon as something is typed', async () => {
    const view = await renderCard(NEW);
    await view.type(L.code, 'N-1');
    expect(view.save()!.disabled).toBe(false);
  });

  describe('the values that depend on the type', () => {
    it('asks for the credit and the points of a prepaid type that collects points, for the collections that exist', async () => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct1');
      expect(view.control(L.initialBalance)).toBeDefined();
      expect(view.control(L.pointsOf('Spring'))).toBeDefined();
      expect(view.control(L.pointsOf('Winter'))).toBeDefined();
      expect(view.model().initialPoints.map((row) => row.collectionId)).toEqual(['pc1', 'pc2']);
      expect(view.text()).toContain('FIDELITY_CARDS.FIELD.INITIAL_BALANCE_HINT');
    });

    it('asks only for the points of a type that only collects points', async () => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct3');
      expect(() => view.control(L.initialBalance)).toThrow();
      expect(view.control(L.pointsOf('Spring'))).toBeDefined();
      expect(() => view.control(L.pointsOf('Winter'))).toThrow();
    });

    it('asks only for the credit of a prepaid type that collects no points', async () => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct4');
      expect(view.control(L.initialBalance)).toBeDefined();
      expect(view.text()).not.toContain('FIDELITY_CARDS.FIELD.INITIAL_POINTS');
    });

    it('asks for nothing of a type with neither', async () => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct2');
      expect(view.text()).not.toContain('FIDELITY_CARDS.FIELD.INITIAL_BALANCE');
      expect(view.text()).not.toContain('FIDELITY_CARDS.FIELD.INITIAL_POINTS');
    });

    it('clears the credit and the points that the new type does not allow', async () => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct1');
      await view.type(L.initialBalance, '5');
      await view.type(L.pointsOf('Spring'), '10');
      await view.type(L.pointsOf('Winter'), '20');
      expect(view.model().initialBalance).toBe('5');

      await chooseType(view, 'ct3');
      expect(view.model().initialBalance).toBe('');
      expect(
        view.model().initialPoints.map(({ collectionId, name, points }) => ({
          collectionId,
          name,
          points,
        })),
      ).toEqual([{ collectionId: 'pc1', name: 'Spring', points: '' }]);

      await chooseType(view, 'ct4');
      expect(view.model().initialPoints).toEqual([]);

      await chooseType(view, 'ct1');
      await view.type(L.initialBalance, '7');
      await chooseType(view, 'ct2');
      expect(view.model().initialBalance).toBe('');
      expect(view.model().initialPoints).toEqual([]);
    });

    it('keeps the credit when the new type is prepaid too', async () => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct1');
      await view.type(L.initialBalance, '5');
      await chooseType(view, 'ct4');
      expect(view.model().initialBalance).toBe('5');
    });

    it('clears everything when the choice of the type is removed', async () => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct1');
      await view.type(L.initialBalance, '5');
      await chooseType(view, '');
      expect(view.model().initialBalance).toBe('');
      expect(view.model().initialPoints).toEqual([]);
      expect(view.model().cardTypeId).toBe('');
    });

    it('asks for no points of a type whose collections cannot be read', async () => {
      const view = await renderCard(NEW, { reads: { collections: 'fail' } });
      await chooseType(view, 'ct1');
      expect(view.model().initialPoints).toEqual([]);
      expect(view.control(L.initialBalance)).toBeDefined();
    });
  });

  describe('the customers to associate', () => {
    const combobox = (view: Awaited<ReturnType<typeof renderCard>>) =>
      view.harness.fixture.debugElement.query(By.directive(SearchCombobox))
        .componentInstance as SearchCombobox;
    const choose = async (
      view: Awaited<ReturnType<typeof renderCard>>,
      value: string,
      label: string,
    ) => {
      combobox(view).choice.emit({ value, label });
      await view.view();
    };
    const names = (view: Awaited<ReturnType<typeof renderCard>>) =>
      [...view.el().querySelectorAll('fieldset li')].map((li) =>
        li.childNodes[0].textContent?.trim(),
      );

    it('searches the contacts of the group from three characters on', async () => {
      const view = await renderCard(NEW, {
        contacts: [{ value: CONTACT_A, label: 'Anna Bianchi' }],
      });
      const box = combobox(view);
      expect(box.minChars()).toBe(3);
      expect(await box.search()('ann')).toEqual([{ value: CONTACT_A, label: 'Anna Bianchi' }]);
      expect(view.search).toHaveBeenCalledWith(GROUP, 'ann');
      expect(view.text()).toContain('FIDELITY_CARDS.FIELD.CUSTOMER_SEARCH');
    });

    it('adds the chosen customers, once each, and lets the user remove them', async () => {
      const view = await renderCard(NEW);
      await choose(view, CONTACT_A, 'Anna Bianchi');
      await choose(view, CONTACT_B, 'Bruno Neri');
      await choose(view, CONTACT_A, 'Anna Bianchi');
      expect(names(view)).toEqual(['Anna Bianchi', 'Bruno Neri']);
      expect(view.save()!.disabled).toBe(false);

      const remove = view.el().querySelector<HTMLButtonElement>('fieldset li button')!;
      expect(remove.getAttribute('aria-label')).toBe(
        'FIDELITY_CARDS.FIELD.CUSTOMER_REMOVE {"name":"Anna Bianchi"}',
      );
      remove.click();
      await view.view();
      expect(names(view)).toEqual(['Bruno Neri']);
    });

    it('ignores a cleared choice', async () => {
      const view = await renderCard(NEW);
      combobox(view).choice.emit(null);
      await view.view();
      expect(view.model().customers).toEqual([]);
    });

    it('takes at most 20 customers and stops offering the search', async () => {
      const view = await renderCard(NEW);
      for (let n = 0; n < FIDELITY_CARD_LIMITS.contacts; n++) {
        await choose(view, `c${n}`, `Cliente ${n}`);
      }
      expect(view.model().customers).toHaveLength(20);
      expect(view.el().querySelector('fc-search-combobox')).toBeNull();
      (
        view.component() as unknown as {
          addCustomer(option: { value: string; label: string }): void;
        }
      ).addCustomer({ value: 'extra', label: 'Extra' });
      expect(view.model().customers).toHaveLength(20);
    });

    it('says the contacts cannot be read, and offers no search, to a user without contacts:read', async () => {
      const view = await renderCard(NEW, { permissions: NO_CONTACTS });
      expect(view.el().querySelector('fc-search-combobox')).toBeNull();
      expect(view.text()).toContain('FIDELITY_CARDS.FIELD.CUSTOMERS_NO_ACCESS');
    });

    it('does not say so to a user who can read the contacts', async () => {
      const view = await renderCard(NEW);
      expect(view.text()).not.toContain('FIDELITY_CARDS.FIELD.CUSTOMERS_NO_ACCESS');
    });

    it('offers no search to a user who cannot write', async () => {
      const view = await renderCard(NEW, { permissions: READ_ONLY });
      expect(view.el().querySelector('fc-search-combobox')).toBeNull();
    });
  });

  describe('validation', () => {
    it('asks for the code and the type, and sends nothing', async () => {
      const view = await renderCard(NEW);
      await view.toggle(L.enabled);
      await view.submit();
      expect(view.error(L.code)).toBe('FORM.ISSUE.REQUIRED');
      expect(view.error(L.type)).toBe('FORM.ISSUE.REQUIRED');
      expect(document.activeElement).toBe(view.control(L.code));
    });

    it.each([
      ['   ', 'FORM.ISSUE.REQUIRED'],
      ['x'.repeat(65), 'FORM.ISSUE.MAX_LENGTH'],
      ['a\tb', 'FORM.ISSUE.PATTERN'],
      ['...', 'FORM.ISSUE.FORMAT'],
    ])('refuses the code %j', async (code, message) => {
      const view = await renderCard(NEW);
      await view.type(L.code, code);
      await view.blur(L.code);
      expect(view.error(L.code)).toBe(message);
    });

    it('asks for the type when the field is left without a choice', async () => {
      const view = await renderCard(NEW);
      expect(view.error(L.type)).toBe('');
      await view.blur(L.type);
      expect(view.error(L.type)).toBe('FORM.ISSUE.REQUIRED');
    });

    it('accepts a code of 64 characters', async () => {
      const view = await renderCard(NEW);
      await view.type(L.code, 'x'.repeat(64));
      await view.blur(L.code);
      expect(view.error(L.code)).toBe('');
    });

    it.each([
      ['abc', 'FORM.ISSUE.TYPE'],
      ['0', 'FORM.ISSUE.INCORRECT'],
      ['0.00', 'FORM.ISSUE.INCORRECT'],
      ['1.234', 'FORM.ISSUE.TYPE'],
      ['1,5', 'FORM.ISSUE.TYPE'],
      ['-1', 'FORM.ISSUE.TYPE'],
      ['1000001', 'FORM.ISSUE.MAXIMUM'],
    ])('refuses the initial credit %j', async (text, message) => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct1');
      await view.type(L.initialBalance, text);
      await view.blur(L.initialBalance);
      expect(view.error(L.initialBalance)).toBe(message);
    });

    it.each(['', '0.5', '1000000', '12.34'])('accepts the initial credit %j', async (text) => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct1');
      await view.type(L.initialBalance, text);
      await view.blur(L.initialBalance);
      expect(view.error(L.initialBalance)).toBe('');
    });

    it.each([
      ['0', 'FORM.ISSUE.INCORRECT'],
      ['1.5', 'FORM.ISSUE.TYPE'],
      ['abc', 'FORM.ISSUE.TYPE'],
      ['-3', 'FORM.ISSUE.TYPE'],
      ['1000001', 'FORM.ISSUE.MAXIMUM'],
    ])('refuses the initial points %j and says so under their own field', async (text, message) => {
      const view = await renderCard(NEW);
      await view.type(L.code, 'N-1');
      await chooseType(view, 'ct1');
      expect(view.error(L.pointsOf('Spring'))).toBe('');
      await view.type(L.pointsOf('Spring'), text);
      expect(view.error(L.pointsOf('Spring'))).toBe(message);
      expect(view.error(L.pointsOf('Winter'))).toBe('');
      await view.submit();
      backend().expectNone(BASE);
    });

    it.each(['', '1', '1000000'])('accepts the initial points %j', async (text) => {
      const view = await renderCard(NEW);
      await chooseType(view, 'ct1');
      await view.type(L.pointsOf('Spring'), text);
      expect(view.error(L.pointsOf('Spring'))).toBe('');
    });

    it('does not ask for the credit of a type that is not prepaid, even if one was typed before', async () => {
      const view = await renderCard(NEW);
      await view.type(L.code, 'N-1');
      await chooseType(view, 'ct1');
      await view.type(L.initialBalance, 'abc');
      await chooseType(view, 'ct3');
      await view.submit();
      expect(backend().match(BASE)).toHaveLength(1);
    });
  });

  describe('creation', () => {
    const fill = async (view: Awaited<ReturnType<typeof renderCard>>) => {
      await view.type(L.code, '  NEW-1  ');
      await chooseType(view, 'ct1');
      await view.type(L.initialBalance, '10.5');
      await view.type(L.pointsOf('Spring'), '30');
    };

    it('sends the code, the type and the state, and only what the type allows, with an idempotency key', async () => {
      const view = await renderCard(NEW);
      await fill(view);
      expect(view.save()!.disabled).toBe(false);
      await view.submit();
      const request = backend().expectOne(BASE);
      expect(request.request.method).toBe('POST');
      expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.request.headers.has('If-Match')).toBe(false);
      expect(request.request.body).toEqual({
        code: 'NEW-1',
        cardTypeId: 'ct1',
        enabled: true,
        initialBalance: 10.5,
        initialPoints: [{ collectionId: 'pc1', points: 30 }],
      });
      request.flush(
        { data: aCard({ id: NEW_ID, code: 'NEW-1' }) },
        { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } },
      );
      await view.answer({ edit: true });
    });

    it('sends the customers as contact ids and the state when the card is created inactive', async () => {
      const view = await renderCard(NEW);
      await view.type(L.code, 'NEW-2');
      await chooseType(view, 'ct2');
      await view.toggle(L.enabled);
      view.harness.fixture.debugElement
        .query(By.directive(SearchCombobox))
        .componentInstance.choice.emit({ value: CONTACT_A, label: 'Anna Bianchi' });
      await view.view();
      await view.submit();
      const request = backend().expectOne(BASE);
      expect(request.request.body).toEqual({
        code: 'NEW-2',
        cardTypeId: 'ct2',
        enabled: false,
        contactIds: [CONTACT_A],
      });
      request.flush(
        { data: aCard({ id: NEW_ID }) },
        { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } },
      );
      await view.answer({ edit: true });
    });

    it('shows the creation as pending, then confirms it with a toast and opens the new card', async () => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      expect(view.save()!.disabled).toBe(true);
      backend()
        .expectOne(BASE)
        .flush(
          { data: aCard({ id: NEW_ID, code: 'NEW-1' }) },
          { status: 201, statusText: 'Created', headers: { ETag: '"v1"' } },
        );
      await view.view();
      expect(view.toasts()).toEqual(['success: FIDELITY_CARDS.FORM.CREATED']);
      expect(view.router.url).toBe(`/groups/${GROUP}/fidelity/cards/${NEW_ID}`);
      await view.answer({ edit: true, card: { code: 'NEW-1' } });
      expect(view.heading()).toBe('NEW-1');
      expect(view.tabs()).toEqual(['general', 'movements']);
    });

    it('presents the same key to a retry of the same body, and a new one when the body changes', async () => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      const first = backend().expectOne(BASE);
      const key = first.request.headers.get('Idempotency-Key');
      first.flush(...failure(500, 'INTERNAL_ERROR'));
      await view.view();
      expect(view.formError()).toBe('ERRORS.API.INTERNAL_ERROR');

      await view.submit();
      const second = backend().expectOne(BASE);
      expect(second.request.headers.get('Idempotency-Key')).toBe(key);
      second.flush(...failure(500, 'INTERNAL_ERROR'));
      await view.view();

      await view.type(L.code, 'NEW-9');
      await view.submit();
      const third = backend().expectOne(BASE);
      expect(third.request.headers.get('Idempotency-Key')).not.toBe(key);
      expect(third.request.body).toMatchObject({ code: 'NEW-9' });
      third.flush(...failure(500, 'INTERNAL_ERROR'));
      await view.view();
    });

    it('puts a 422 on the code and on the type, and keeps the page for the user to correct', async () => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      backend()
        .expectOne(BASE)
        .flush(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'x',
              details: [
                { field: 'code', issue: 'maxLength' },
                { field: 'cardTypeId', issue: 'notFound' },
              ],
            },
          },
          { status: 422, statusText: 'x' },
        );
      await view.view();
      expect(view.error(L.code)).not.toBe('');
      expect(view.error(L.type)).not.toBe('');
      expect(view.formError()).toBeNull();
      expect(view.router.url).toBe(NEW);
    });

    it('puts a 409 code taken on the code', async () => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      backend()
        .expectOne(BASE)
        .flush(
          {
            error: {
              code: 'CONFLICT',
              message: 'x',
              details: [{ field: 'code', issue: 'taken' }],
            },
          },
          { status: 409, statusText: 'x' },
        );
      await view.view();
      expect(view.error(L.code)).not.toBe('');
      expect(view.formError()).toBeNull();
    });

    it.each([
      ['a field of the form that is not the code or the type', 'initialBalance'],
      ['a field the form does not have', 'somethingElse'],
    ])('says the data are not valid when the 422 is on %s', async (_label, field) => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      backend()
        .expectOne(BASE)
        .flush(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'x',
              details: [{ field, issue: 'incorrect' }],
            },
          },
          { status: 422, statusText: 'x' },
        );
      await view.view();
      expect(view.formError()).toBe('ERRORS.API.VALIDATION_ERROR');
    });

    it.each([
      [422, 'VALIDATION_ERROR', 'ERRORS.API.VALIDATION_ERROR'],
      [403, 'FORBIDDEN', 'ERRORS.API.FORBIDDEN'],
      [404, 'NOT_FOUND', 'ERRORS.API.NOT_FOUND'],
      [500, 'INTERNAL_ERROR', 'ERRORS.API.INTERNAL_ERROR'],
    ])('shows the text of a %s without details', async (status, code, message) => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      backend()
        .expectOne(BASE)
        .flush(...failure(status, code));
      await view.view();
      expect(view.formError()).toBe(message);
      expect(view.reload()).toBeUndefined();
    });

    it('says a previous request is still being checked on a 409 pending, without marking a field', async () => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      backend()
        .expectOne(BASE)
        .flush(
          {
            error: {
              code: 'CONFLICT',
              message: 'x',
              details: [{ field: 'Idempotency-Key', issue: 'pending' }],
            },
          },
          { status: 409, statusText: 'x' },
        );
      await view.view();
      expect(view.formError()).toBe('FIDELITY_CARDS.ERROR.KEY_PENDING');
      expect(view.error(L.code)).toBe('');
      expect(view.reload()).toBeUndefined();
    });

    it('says the check is too slow after a 503', async () => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      backend()
        .expectOne(BASE)
        .flush(...failure(503, 'SERVICE_UNAVAILABLE'));
      await view.view();
      expect(view.formError()).toBe('FIDELITY_CARDS.ERROR.TOO_SLOW');
    });

    it('says how long to wait after a 429', async () => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      backend()
        .expectOne(BASE)
        .flush(
          { error: { code: 'RATE_LIMITED', message: 'x' } },
          { status: 429, statusText: 'x', headers: { 'Retry-After': '30' } },
        );
      await view.view();
      expect(view.formError()).toContain('ERRORS.API.RATE_LIMITED_WAIT');
    });

    it('clears the failure of the last attempt at the next one', async () => {
      const view = await renderCard(NEW);
      await fill(view);
      await view.submit();
      backend()
        .expectOne(BASE)
        .flush(...failure(500, 'INTERNAL_ERROR'));
      await view.view();
      expect(view.formError()).not.toBeNull();
      await view.submit();
      expect(view.formError()).toBeNull();
      backend()
        .expectOne(BASE)
        .flush(...failure(500, 'INTERNAL_ERROR'));
      await view.view();
    });
  });

  describe('leaving the page', () => {
    it('lets the user leave an empty form without asking', async () => {
      const view = await renderCard(NEW);
      expect(view.component().confirmLeave()).toBe(true);
      expect(view.el().querySelector('dialog[open]')).toBeNull();
    });

    it('asks to confirm when something was typed, and leaves when the user confirms', async () => {
      const view = await renderCard(NEW);
      await view.type(L.code, 'N-1');
      const answer = view.component().confirmLeave();
      await view.view();
      expect(answer).toBeInstanceOf(Promise);
      expect(view.el().querySelector('dialog[open]')?.textContent).toContain(
        'FIDELITY_CARDS.LEAVE.MESSAGE',
      );
      view.dialogButton('FIDELITY_CARDS.LEAVE.CONFIRM').click();
      await view.view();
      expect(await answer).toBe(true);
      expect(view.el().querySelector('dialog[open]')).toBeNull();
    });

    it('stays when the user cancels', async () => {
      const view = await renderCard(NEW);
      await view.type(L.code, 'N-1');
      const answer = view.component().confirmLeave();
      await view.view();
      view.dialogButton('COMMON.CANCEL').click();
      await view.view();
      expect(await answer).toBe(false);
      expect(view.el().querySelector('dialog[open]')).toBeNull();
      expect(view.control(L.code).value).toBe('N-1');
    });

    it('holds a navigation to another page until the user decides', async () => {
      const view = await renderCard(NEW);
      await view.type(L.code, 'N-1');
      const navigation = view.router.navigateByUrl(LIST_ROUTE);
      await view.view();
      expect(view.router.url).toBe(NEW);
      view.dialogButton('FIDELITY_CARDS.LEAVE.CONFIRM').click();
      await view.view();
      expect(await navigation).toBe(true);
      expect(view.router.url).toBe(LIST_ROUTE);
    });
  });
});

/** The body and the options of the answer of a failed request. */
function failure(status: number, code: string) {
  return [{ error: { code, message: 'x' } }, { status, statusText: 'x' }] as const;
}
