import { Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { signIn } from '../../../../testing/session';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { Role } from '../../../core/session/session.types';
import { PlacePerimeter } from './place-perimeter';

@Component({ template: '', providers: [PlacePerimeter] })
class Host {
  readonly groupId = signal('g1');
  readonly perimeter = inject(PlacePerimeter);
  constructor() {
    this.perimeter.attach(this.groupId);
  }
}

async function render(role: Role, ids: ReadonlySet<string> | null | Error) {
  const placeIds = vi
    .spyOn(ReferenceApi.prototype, 'placeIds')
    .mockImplementation(() => (ids instanceof Error ? Promise.reject(ids) : Promise.resolve(ids)));
  signIn({ role });
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return {
    fixture,
    host: fixture.componentInstance,
    perimeter: fixture.componentInstance.perimeter,
    placeIds,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('PlacePerimeter', () => {
  it.each<[Role, boolean]>([
    ['PSA', false],
    ['D', false],
    ['SA', false],
    ['CA', true],
    ['PA', true],
  ])('%s restricted: %s', async (role, restricted) => {
    const { perimeter } = await render(role, new Set(['p1']));
    expect(perimeter.restricted()).toBe(restricted);
  });

  it('allows anything to who is not restricted, without reading the stores', async () => {
    const { perimeter, placeIds } = await render('SA', new Set());
    expect(perimeter.covers([])).toBe(true);
    expect(perimeter.covers(['x'])).toBe(true);
    expect(perimeter.allowed()).toBeNull();
    expect(placeIds).not.toHaveBeenCalled();
  });

  it('reads the stores of the group of the restricted user', async () => {
    const { perimeter, placeIds } = await render('CA', new Set(['p1', 'p2']));
    expect(placeIds).toHaveBeenCalledWith('g1');
    expect(perimeter.allowed()).toEqual(new Set(['p1', 'p2']));
  });

  it('requires a restricted user to name stores of the perimeter', async () => {
    const { perimeter } = await render('PA', new Set(['p1', 'p2']));
    expect(perimeter.covers([])).toBe(false);
    expect(perimeter.covers(['p1'])).toBe(true);
    expect(perimeter.covers(['p1', 'p2'])).toBe(true);
    expect(perimeter.covers(['p1', 'other'])).toBe(false);
  });

  it('leaves the judgment to the server when the stores are not known', async () => {
    const { perimeter } = await render('CA', null);
    expect(perimeter.allowed()).toBeNull();
    expect(perimeter.covers(['whatever'])).toBe(true);
    expect(perimeter.covers([])).toBe(false);
  });

  it('does the same when the stores cannot be read', async () => {
    const { perimeter } = await render('CA', new Error('offline'));
    expect(perimeter.allowed()).toBeNull();
    expect(perimeter.covers(['whatever'])).toBe(true);
  });

  it('reads nothing until attached to a group', async () => {
    const placeIds = vi.spyOn(ReferenceApi.prototype, 'placeIds').mockResolvedValue(new Set());
    TestBed.configureTestingModule({ providers: [PlacePerimeter] });
    signIn({ role: 'CA' });
    const perimeter = TestBed.inject(PlacePerimeter);
    TestBed.tick();
    expect(placeIds).not.toHaveBeenCalled();
    expect(perimeter.allowed()).toBeNull();
  });
});
