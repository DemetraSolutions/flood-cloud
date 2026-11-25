import { backend } from '../../../testing/api';
import {
  ADJUSTMENTS,
  aCard,
  EDIT,
  ITEM,
  L,
  LIST_ROUTE,
  MOVEMENTS,
  renderCard,
} from '../../../testing/fidelity-card-page';

type View = Awaited<ReturnType<typeof renderCard>>;

afterEach(() => {
  backend().verify({ ignoreCancelled: true });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
  localStorage.clear();
});

/** The answer of a failed request. */
function failure(status: number, code: string, details?: { field: string; issue: string }[]) {
  return [
    { error: { code, message: 'x', ...(details === undefined ? {} : { details }) } },
    { status, statusText: 'x' },
  ] as const;
}

describe('FidelityCardPage: saving', () => {
  it('sends only the type when only the type changed, with the version read', async () => {
    const view = await renderCard(EDIT);
    await view.type(L.type, 'ct2');
    expect(view.save()!.disabled).toBe(false);
    await view.submit();
    const request = backend().expectOne(ITEM);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ cardTypeId: 'ct2' });
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    expect(request.request.headers.has('Idempotency-Key')).toBe(false);
    request.flush(
      { data: aCard({ cardTypeId: 'ct2', balance: null, points: [] }) },
      { headers: { ETag: '"v2"' } },
    );
    await view.view();
    expect(view.toasts()).toEqual(['success: FIDELITY_CARDS.FORM.SAVED']);
    expect(view.save()!.disabled).toBe(true);
    expect((view.control(L.type) as HTMLSelectElement).value).toBe('ct2');
  });

  it('sends only the state when only the state changed, and the next save uses the new version', async () => {
    const view = await renderCard(EDIT);
    await view.toggle(L.enabled);
    await view.submit();
    const first = backend().expectOne(ITEM);
    expect(first.request.body).toEqual({ enabled: false });
    first.flush({ data: aCard({ enabled: false }) }, { headers: { ETag: '"v2"' } });
    await view.view();

    await view.toggle(L.enabled);
    await view.submit();
    const second = backend().expectOne(ITEM);
    expect(second.request.body).toEqual({ enabled: true });
    expect(second.request.headers.get('If-Match')).toBe('"v2"');
    second.flush({ data: aCard() }, { headers: { ETag: '"v3"' } });
    await view.view();
  });

  it('sends the type and the state together, and does not ask for the initial values', async () => {
    const view = await renderCard(EDIT);
    await view.type(L.type, 'ct3');
    await view.toggle(L.enabled);
    expect(view.model().initialPoints).toEqual([]);
    expect(view.model().initialBalance).toBe('');
    await view.submit();
    const request = backend().expectOne(ITEM);
    expect(request.request.body).toEqual({ cardTypeId: 'ct3', enabled: false });
    request.flush({ data: aCard({ cardTypeId: 'ct3', enabled: false }) });
    await view.view();
  });

  it('sends no If-Match when the read gave no version', async () => {
    const view = await renderCard(EDIT, { reads: { etag: null } });
    await view.toggle(L.enabled);
    await view.submit();
    const request = backend().expectOne(ITEM);
    expect(request.request.headers.has('If-Match')).toBe(false);
    request.flush({ data: aCard({ enabled: false }) });
    await view.view();
  });

  it('refuses to save without a type, and says so', async () => {
    const view = await renderCard(EDIT);
    await view.type(L.type, '');
    await view.submit();
    expect(view.error(L.type)).toBe('FORM.ISSUE.REQUIRED');
    backend().expectNone(ITEM);
  });

  it('shows the pending save and ignores a second submission meanwhile', async () => {
    const view = await renderCard(EDIT);
    await view.toggle(L.enabled);
    await view.submit();
    await view.submit();
    expect(view.save()!.disabled).toBe(true);
    backend()
      .expectOne(ITEM)
      .flush({ data: aCard({ enabled: false }) });
    await view.view();
    expect(view.save()!.disabled).toBe(true);
  });

  describe('failures', () => {
    const attempt = async (view: View) => {
      await view.toggle(L.enabled);
      await view.submit();
    };

    it.each([
      ['412 precondition failed', 412, 'PRECONDITION_FAILED'],
      ['409 without details', 409, 'CONFLICT'],
    ])('offers to read the card again after a %s', async (_label, status, code) => {
      const view = await renderCard(EDIT);
      await attempt(view);
      backend()
        .expectOne(ITEM)
        .flush(...failure(status, code));
      await view.view();
      expect(view.formError()).toBe('FIDELITY_CARDS.FORM.STALE');
      expect(view.reload()).toBeDefined();
      expect(view.model().enabled).toBe(false);

      view.reload()!.click();
      await view.view();
      expect(view.formError()).toBeNull();
      await view.answer({ card: { enabled: true, code: 'CARD-NEW' }, etag: '"v9"' });
      expect(view.heading()).toBe('CARD-NEW');
      expect(view.reload()).toBeUndefined();
      expect(view.save()!.disabled).toBe(true);
    });

    it('puts a 422 on the type', async () => {
      const view = await renderCard(EDIT);
      await attempt(view);
      backend()
        .expectOne(ITEM)
        .flush(...failure(422, 'VALIDATION_ERROR', [{ field: 'cardTypeId', issue: 'notFound' }]));
      await view.view();
      expect(view.error(L.type)).not.toBe('');
      expect(view.formError()).toBeNull();
      expect(view.reload()).toBeUndefined();
    });

    it('says the data are not valid for a 422 on another field', async () => {
      const view = await renderCard(EDIT);
      await attempt(view);
      backend()
        .expectOne(ITEM)
        .flush(...failure(422, 'VALIDATION_ERROR', [{ field: 'enabled', issue: 'type' }]));
      await view.view();
      expect(view.formError()).toBe('ERRORS.API.VALIDATION_ERROR');
    });

    it.each([
      [403, 'FORBIDDEN', 'ERRORS.API.FORBIDDEN'],
      [404, 'NOT_FOUND', 'ERRORS.API.NOT_FOUND'],
      [422, 'VALIDATION_ERROR', 'ERRORS.API.VALIDATION_ERROR'],
      [500, 'INTERNAL_ERROR', 'ERRORS.API.INTERNAL_ERROR'],
    ])('shows the text of a %s', async (status, code, message) => {
      const view = await renderCard(EDIT);
      await attempt(view);
      backend()
        .expectOne(ITEM)
        .flush(...failure(status, code));
      await view.view();
      expect(view.formError()).toBe(message);
      expect(view.reload()).toBeUndefined();
    });

    it.each([
      ['balance', 'notEmpty', 'FIDELITY_CARDS.ERROR.BALANCE_NOT_EMPTY'],
      ['Idempotency-Key', 'pending', 'FIDELITY_CARDS.ERROR.KEY_PENDING'],
    ])(
      'says why a 409 on %s (%s) is refused, with no field marked and no reload',
      async (field, issue, message) => {
        const view = await renderCard(EDIT);
        await attempt(view);
        backend()
          .expectOne(ITEM)
          .flush(...failure(409, 'CONFLICT', [{ field, issue }]));
        await view.view();
        expect(view.formError()).toBe(message);
        expect(view.error(L.type)).toBe('');
        expect(view.reload()).toBeUndefined();
      },
    );

    it('says the check is too slow after a 503', async () => {
      const view = await renderCard(EDIT);
      await attempt(view);
      backend()
        .expectOne(ITEM)
        .flush(...failure(503, 'SERVICE_UNAVAILABLE'));
      await view.view();
      expect(view.formError()).toBe('FIDELITY_CARDS.ERROR.TOO_SLOW');
    });

    it('says how long to wait after a 429', async () => {
      const view = await renderCard(EDIT);
      await attempt(view);
      backend()
        .expectOne(ITEM)
        .flush(
          { error: { code: 'RATE_LIMITED', message: 'x' } },
          { status: 429, statusText: 'x', headers: { 'Retry-After': '30' } },
        );
      await view.view();
      expect(view.formError()).toContain('ERRORS.API.RATE_LIMITED_WAIT');
    });
  });
});

describe('FidelityCardPage: deleting', () => {
  const open = async (view: View) => {
    view.button('FIDELITY_CARDS.DELETE.ACTION')!.click();
    await view.view();
  };

  it('asks to confirm with the code of the card, and does nothing when the user cancels', async () => {
    const view = await renderCard(EDIT);
    await open(view);
    const dialog = view.el().querySelector('dialog[open]')!;
    expect(dialog.textContent).toContain('FIDELITY_CARDS.DELETE.TITLE');
    expect(dialog.textContent).toContain('FIDELITY_CARDS.DELETE.CONFIRM {"code":"CARD-001"}');
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    backend().expectNone(ITEM);
  });

  it('deletes with the version read, confirms with a toast and goes back to the list', async () => {
    const view = await renderCard(EDIT);
    await open(view);
    view.dialogButton('FIDELITY_CARDS.DELETE.ACTION').click();
    await view.view();
    expect(view.dialogButton('FIDELITY_CARDS.DELETE.ACTION').disabled).toBe(true);
    const request = backend().expectOne(ITEM);
    expect(request.request.method).toBe('DELETE');
    expect(request.request.headers.get('If-Match')).toBe('"v1"');
    request.flush(null, { status: 204, statusText: 'No Content' });
    await view.view();
    expect(view.toasts()).toEqual(['success: FIDELITY_CARDS.DELETE.DONE']);
    expect(view.router.url).toBe(LIST_ROUTE);
  });

  const remove = async (view: View, status: number, code: string, details = false) => {
    await open(view);
    view.dialogButton('FIDELITY_CARDS.DELETE.ACTION').click();
    await view.view();
    backend()
      .expectOne(ITEM)
      .flush(
        {
          error: {
            code,
            message: 'x',
            ...(details ? { details: [{ field: 'id', issue: 'referenced' }] } : {}),
          },
        },
        { status, statusText: 'x' },
      );
    await view.view();
  };

  it('says to deactivate a card that has a history or customers (409 referenced)', async () => {
    const view = await renderCard(EDIT);
    await remove(view, 409, 'CONFLICT', true);
    expect(view.formError()).toBe('FIDELITY_CARDS.ERROR.HAS_HISTORY');
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    expect(view.reload()).toBeUndefined();
    expect(view.router.url).toBe(EDIT);
    expect(view.button('FIDELITY_CARDS.DELETE.ACTION')!.disabled).toBe(false);
  });

  it.each([
    ['a 409 for another reason', 409, 'CONFLICT'],
    ['a 412', 412, 'PRECONDITION_FAILED'],
  ])('offers to read the card again after %s', async (_label, status, code) => {
    const view = await renderCard(EDIT);
    await remove(view, status, code);
    expect(view.formError()).toBe('FIDELITY_CARDS.FORM.STALE');
    expect(view.reload()).toBeDefined();
    expect(view.el().querySelector('dialog[open]')).toBeNull();
  });

  it('says the check is too slow after a 503', async () => {
    const view = await renderCard(EDIT);
    await remove(view, 503, 'SERVICE_UNAVAILABLE');
    expect(view.formError()).toBe('FIDELITY_CARDS.ERROR.TOO_SLOW');
  });

  it.each([
    [403, 'FORBIDDEN', 'ERRORS.API.FORBIDDEN'],
    [404, 'NOT_FOUND', 'ERRORS.API.NOT_FOUND'],
    [500, 'INTERNAL_ERROR', 'ERRORS.API.INTERNAL_ERROR'],
  ])('shows the text of a %s', async (status, code, message) => {
    const view = await renderCard(EDIT);
    await remove(view, status, code);
    expect(view.formError()).toBe(message);
    expect(view.router.url).toBe(EDIT);
  });
});

describe('FidelityCardPage: leaving with unsaved changes', () => {
  it('asks to confirm after a change, and does not once the change is saved', async () => {
    const view = await renderCard(EDIT);
    expect(view.component().confirmLeave()).toBe(true);
    await view.toggle(L.enabled);
    const answer = view.component().confirmLeave();
    await view.view();
    expect(answer).toBeInstanceOf(Promise);
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
    expect(await answer).toBe(false);

    await view.submit();
    backend()
      .expectOne(ITEM)
      .flush({ data: aCard({ enabled: false }) });
    await view.view();
    expect(view.component().confirmLeave()).toBe(true);
  });

  it('holds the navigation and lets it go when the user confirms', async () => {
    const view = await renderCard(EDIT);
    await view.type(L.type, 'ct2');
    const navigation = view.router.navigateByUrl(LIST_ROUTE);
    await view.view();
    expect(view.router.url).toBe(EDIT);
    view.dialogButton('FIDELITY_CARDS.LEAVE.CONFIRM').click();
    await view.view();
    expect(await navigation).toBe(true);
    expect(view.router.url).toBe(LIST_ROUTE);
  });

  it('keeps the page when the user cancels the navigation', async () => {
    const view = await renderCard(EDIT);
    await view.type(L.type, 'ct2');
    const navigation = view.router.navigateByUrl(LIST_ROUTE);
    await view.view();
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
    expect(await navigation).toBe(false);
    expect(view.router.url).toBe(EDIT);
    expect((view.control(L.type) as HTMLSelectElement).value).toBe('ct2');
  });
});

describe('FidelityCardPage: the adjustment', () => {
  it('shows the new balances and reads the history again without touching what was typed', async () => {
    const view = await renderCard(EDIT);
    await view.type(L.type, 'ct2');
    view.button('FIDELITY_CARDS.BALANCES.ADJUST')!.click();
    await view.view();
    expect(view.el().querySelector('dialog[open]')).not.toBeNull();

    const dialog = view.el().querySelector('dialog[open]')!;
    const amount = dialog.querySelector<HTMLInputElement>('fieldset input')!;
    amount.value = '2.5';
    amount.dispatchEvent(new Event('input'));
    await view.view();
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await view.view();
    const request = backend().expectOne(ADJUSTMENTS);
    expect(request.request.body).toEqual({ balanceDelta: 2.5 });
    request.flush({
      data: aCard({
        balance: 15,
        points: [{ collectionId: 'pc1', name: 'Spring', points: 125, active: true }],
      }),
    });
    await view.view();

    expect(view.text()).toMatch(/FIDELITY_CARDS\.BALANCES\.CREDIT \{"amount":"15,00\s€"\}/);
    expect(view.el().querySelector('fieldset')?.textContent).toContain('"points":"125"');
    expect((view.control(L.type) as HTMLSelectElement).value).toBe('ct2');
    expect(view.save()!.disabled).toBe(false);
    backend()
      .expectOne(`${MOVEMENTS}?limit=25`)
      .flush({ data: [], page: { limit: 25, next: null } });
    await view.view();

    view.dialogButton('COMMON.CLOSE').click();
    await view.view();
    expect(view.el().querySelector('dialog[open]')).toBeNull();
    view.button('FIDELITY_CARDS.BALANCES.ADJUST')!.click();
    await view.view();
    expect(view.el().querySelector('dialog[open]')).not.toBeNull();
    view.dialogButton('COMMON.CANCEL').click();
    await view.view();
    expect(view.el().querySelector('dialog[open]')).toBeNull();

    await view.submit();
    const patch = backend().expectOne(ITEM);
    expect(patch.request.body).toEqual({ cardTypeId: 'ct2' });
    expect(patch.request.headers.get('If-Match')).toBe('"v1"');
    patch.flush({ data: aCard({ cardTypeId: 'ct2' }) });
    await view.view();
  });

  describe('an outcome that is not known', () => {
    /** Opens the dialog, sends an adjustment that fails with a server error and closes the dialog. */
    const doubtful = async (view: View) => {
      view.button('FIDELITY_CARDS.BALANCES.ADJUST')!.click();
      await view.view();
      const dialog = view.el().querySelector('dialog[open]')!;
      const amount = dialog.querySelector<HTMLInputElement>('fieldset input')!;
      amount.value = '1';
      amount.dispatchEvent(new Event('input'));
      await view.view();
      dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await view.view();
      backend()
        .expectOne(ADJUSTMENTS)
        .flush(...failure(500, 'INTERNAL_ERROR'));
      await view.view();
      expect(dialog.textContent).toContain('FIDELITY_CARDS.ADJUST.UNCERTAIN');
      view.dialogButton('COMMON.CANCEL').click();
      await view.view();
    };

    it('reads the card and its history again on close, without touching what was typed', async () => {
      const view = await renderCard(EDIT);
      await view.type(L.type, 'ct2');
      await doubtful(view);
      backend()
        .expectOne(ITEM)
        .flush({ data: aCard({ balance: 99, points: [] }) }, { headers: { ETag: '"v7"' } });
      backend()
        .expectOne(`${MOVEMENTS}?limit=25`)
        .flush({ data: [], page: { limit: 25, next: null } });
      await view.view();
      expect(view.text()).toMatch(/CREDIT \{"amount":"99,00\s€"\}/);
      expect((view.control(L.type) as HTMLSelectElement).value).toBe('ct2');
      expect(view.save()!.disabled).toBe(false);
      expect(view.toasts()).toEqual([]);
    });

    it('shows an error toast when the card cannot be read again', async () => {
      const view = await renderCard(EDIT);
      await doubtful(view);
      backend()
        .expectOne(ITEM)
        .flush(...failure(500, 'INTERNAL_ERROR'));
      backend()
        .expectOne(`${MOVEMENTS}?limit=25`)
        .flush({ data: [], page: { limit: 25, next: null } });
      await view.view();
      expect(view.toasts()).toEqual(['error: ERRORS.API.INTERNAL_ERROR']);
      expect(view.text()).toMatch(/CREDIT \{"amount":"12,50\s€"\}/);
    });
  });
});
