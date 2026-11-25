import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API, backend, errorBody, provideApiTesting, settle } from '../../../testing/api';
import { AppConfig } from '../../core/config/app-config';
import { I18nService } from '../../core/i18n/i18n.service';
import { FidelityCardMovements } from './fidelity-card-movements';
import { CardMovement } from './fidelity-card.types';

const GROUP = '665f1c2e9b1d4a0012ab34a1';
const CARD = '665f1c2e9b1d4a0012ab34c1';
const URL = `${API}/v1/groups/${GROUP}/fidelity-cards/${CARD}/movements`;

function movement(id: string, over: Partial<CardMovement> = {}): CardMovement {
  return {
    id,
    date: '2026-05-01T10:30:00.000Z',
    type: 'manually',
    balance: -2.5,
    points: 10,
    collection: { id: 'pc1', name: 'Spring' },
    operator: { kind: 'user', id: 'u1', name: 'Mario Verdi' },
    ...over,
  };
}

const page = (data: CardMovement[], next: string | null = null) => ({
  data,
  page: { limit: 25, next },
});

@Component({
  imports: [FidelityCardMovements],
  template: `<fc-fidelity-card-movements
    [groupId]="group"
    [cardId]="card"
    [refresh]="refresh()"
  />`,
})
class Host {
  readonly group = GROUP;
  readonly card = CARD;
  readonly refresh = signal(0);
}

async function render(noApi = false) {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...(noApi ? [{ provide: AppConfig, useValue: { apiBaseUrl: signal(null) } }] : []),
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  const root = fixture.nativeElement as HTMLElement;
  document.body.appendChild(root);
  const view = async () => {
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  };
  await view();
  const request = () => backend().expectOne((r) => r.url === URL);
  const params = (req: ReturnType<typeof request>) =>
    Object.fromEntries(req.request.params.keys().map((k) => [k, req.request.params.get(k)]));
  const flush = async (data: CardMovement[], next: string | null = null) => {
    const req = request();
    req.flush(page(data, next));
    await view();
    return req;
  };
  const cells = (index: number) =>
    [...root.querySelectorAll('tbody tr')[index]!.querySelectorAll('th, td')].map((c) =>
      c.textContent?.trim(),
    );
  return { fixture, root, view, request, params, flush, cells };
}

afterEach(() => {
  backend().verify();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('FidelityCardMovements', () => {
  it('requests the first page and shows the movements with their sign', async () => {
    const { request, params, view, root, cells } = await render();
    const req = request();
    expect(params(req)).toEqual({ limit: '25' });
    req.flush(
      page([
        movement('m1'),
        movement('m2', { type: 'sale', balance: 4, points: -3 }),
        movement('m3', { type: 'import', balance: 0, points: 0 }),
        movement('m4', { type: 'canceled_sale' }),
      ]),
    );
    await view();
    expect(root.querySelector('table caption')?.textContent?.trim()).toBe(
      'FIDELITY_CARDS.SECTION.MOVEMENTS',
    );
    expect([...root.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual([
      'FIDELITY_CARDS.MOVEMENT.DATE',
      'FIDELITY_CARDS.MOVEMENT.TYPE',
      'FIDELITY_CARDS.MOVEMENT.COLLECTION',
      'FIDELITY_CARDS.MOVEMENT.POINTS',
      'FIDELITY_CARDS.MOVEMENT.BALANCE',
      'FIDELITY_CARDS.MOVEMENT.OPERATOR',
    ]);
    const first = cells(0);
    expect(first[0]).not.toBe('');
    expect(first.slice(1, 3)).toEqual(['FIDELITY_CARDS.MOVEMENT.TYPE_MANUALLY', 'Spring']);
    expect(first[3]).toBe('+10');
    expect(first[4]).toMatch(/^[-−]2[.,]50$/);
    expect(first[5]).toBe('Mario Verdi');
    expect(cells(1)[1]).toBe('FIDELITY_CARDS.MOVEMENT.TYPE_SALE');
    expect(cells(1)[3]).toMatch(/^[-−]3$/);
    expect(cells(1)[4]).toMatch(/^\+4[.,]00$/);
    expect(cells(2)[1]).toBe('FIDELITY_CARDS.MOVEMENT.TYPE_IMPORT');
    expect(cells(2)[3]).toBe('0');
    expect(cells(3)[1]).toBe('FIDELITY_CARDS.MOVEMENT.TYPE_CANCELED_SALE');
  });

  it('shows what is missing as empty and an unknown type as other', async () => {
    const { flush, cells } = await render();
    await flush([
      movement('m1', {
        type: 'future',
        date: null,
        balance: null,
        points: null,
        collection: null,
        operator: null,
      }),
      movement('m2', {
        type: null,
        collection: { id: 'pc1', name: null },
        operator: { kind: 'user', id: 'u', name: null },
      }),
    ]);
    expect(cells(0)).toEqual(['', 'FIDELITY_CARDS.MOVEMENT.TYPE_OTHER', '', '', '', '–']);
    expect(cells(1)[1]).toBe('FIDELITY_CARDS.MOVEMENT.TYPE_OTHER');
    expect(cells(1)[2]).toBe('');
    expect(cells(1)[5]).toBe('');
  });

  it('shows an integration by name, with a fallback for a missing name', async () => {
    const { flush, cells } = await render();
    await flush([
      movement('m1', { operator: { kind: 'apiKey', id: 'k1', name: 'Sito' } }),
      movement('m2', { operator: { kind: 'apiKey', id: 'k2', name: null } }),
    ]);
    expect(cells(0)[5]).toContain('FIDELITY_CARDS.MOVEMENT.INTEGRATION');
    expect(cells(1)[5]).toContain('FIDELITY_CARDS.MOVEMENT.INTEGRATION');
  });

  it('shows the cash desk for a movement made by the store', async () => {
    const { flush, cells } = await render();
    await flush([
      movement('m1', { operator: { kind: 'user', id: 'u1', name: 'Mario', store: true } }),
      movement('m2', { operator: { kind: 'user', id: 'u1', name: 'Mario', store: false } }),
    ]);
    expect(cells(0)[5]).toBe('FIDELITY_CARDS.MOVEMENT.STORE_OPERATOR {"name":"Mario"}');
    expect(cells(1)[5]).toBe('Mario');
  });

  it('shows the loading state, then the empty one', async () => {
    const { request, view, root } = await render();
    expect(root.querySelector('fc-skeleton')).not.toBeNull();
    request().flush(page([]));
    await view();
    expect(root.querySelector('fc-empty-state')?.textContent).toContain(
      'FIDELITY_CARDS.MOVEMENT.EMPTY',
    );
  });

  it('shows the error state with the request id and retries', async () => {
    const { request, view, root, flush } = await render();
    request().flush(errorBody('INTERNAL_ERROR'), {
      status: 500,
      statusText: 'x',
      headers: { 'X-Request-Id': 'req-9' },
    });
    await view();
    const state = root.querySelector('fc-error-state')!;
    expect(state.textContent).toContain('FIDELITY_CARDS.MOVEMENT.LOAD_ERROR');
    expect(state.textContent).toContain('ERRORS.API.INTERNAL_ERROR');
    expect(state.textContent).toContain('req-9');
    state.querySelector('button')!.click();
    await view();
    await flush([movement('m1')]);
    expect(root.querySelector('fc-error-state')).toBeNull();
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('shows the generic error for a failure that is not an API error', async () => {
    const { view, root } = await render(true);
    await view();
    expect(root.querySelector('fc-error-state')?.textContent).toContain('ERRORS.GENERIC.MESSAGE');
  });

  it('reads again when refresh changes', async () => {
    const { fixture, flush, view, root } = await render();
    await flush([movement('m1')]);
    fixture.componentInstance.refresh.set(1);
    await view();
    await flush([movement('m1'), movement('m2')]);
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('walks the pages back and forth and changes the page size', async () => {
    const { flush, request, params, view, root } = await render();
    await flush([movement('m1')], 'c1');
    const [previous, next] = [
      ...root.querySelectorAll<HTMLButtonElement>('fc-cursor-paginator .buttons button'),
    ];
    expect(previous!.disabled).toBe(true);
    next!.click();
    await view();
    let req = request();
    expect(params(req)).toEqual({ limit: '25', cursor: 'c1' });
    req.flush(page([movement('m2')], 'c2'));
    await view();
    next!.click();
    await view();
    req = request();
    expect(params(req)['cursor']).toBe('c2');
    req.flush(page([movement('m3')]));
    await view();
    previous!.click();
    await view();
    req = request();
    expect(params(req)['cursor']).toBe('c1');
    req.flush(page([movement('m2')], 'c2'));
    await view();
    previous!.click();
    await view();
    req = request();
    expect(params(req)).toEqual({ limit: '25' });
    req.flush(page([movement('m1')], 'c1'));
    await view();
    next!.click();
    await view();
    request().flush(page([movement('m2')]));
    await view();
    const size = root.querySelector<HTMLSelectElement>('fc-cursor-paginator select')!;
    size.value = '50';
    size.dispatchEvent(new Event('change'));
    await view();
    req = request();
    expect(params(req)).toEqual({ limit: '50' });
    req.flush(page([movement('m1')]));
    await view();
    expect(previous!.disabled).toBe(true);
  });
});
