import { ApiError } from '../../core/api/api-error';
import { COMPANY_ROW, GROUP_ROW, PLACE_ROW, result, USER_ROW, GROUP } from '../../../testing/trash';
import { summarize, platformIssue, trashRowLabel, trashRowRoute } from './trash.types';

describe('summarize', () => {
  it('counts what was restored and deleted and lists what was skipped', () => {
    const summary = summarize([
      result('a', 'restored'),
      result('b', 'restored'),
      result('c', 'deleted'),
      result('d', 'skipped', 'referenced'),
      result('e', 'skipped'),
    ]);
    expect(summary).toEqual({
      restored: 2,
      deleted: 1,
      skipped: [
        { id: 'd', issue: 'referenced' },
        { id: 'e', issue: 'notFound' },
      ],
      failedGroups: [],
    });
  });

  it('counts an item skipped again once, unless a later call handled it', () => {
    const summary = summarize([
      result('a', 'skipped', 'referenced'),
      result('b', 'skipped', 'forbidden'),
      result('a', 'skipped', 'referenced'),
      result('b', 'deleted'),
      result('c', 'skipped', 'taken'),
      result('c', 'restored'),
    ]);
    expect(summary).toEqual({
      restored: 1,
      deleted: 1,
      skipped: [{ id: 'a', issue: 'referenced' }],
      failedGroups: [],
    });
  });

  it('has nothing for no results', () => {
    expect(summarize([])).toEqual({ restored: 0, deleted: 0, skipped: [], failedGroups: [] });
  });
});

describe('trashRowRoute', () => {
  it('opens the detail page of each kind', () => {
    expect(trashRowRoute('companies', GROUP, COMPANY_ROW)).toEqual([
      '/groups',
      GROUP,
      'companies',
      COMPANY_ROW.id,
    ]);
    expect(trashRowRoute('places', GROUP, PLACE_ROW)).toEqual([
      '/groups',
      GROUP,
      'places',
      PLACE_ROW.id,
    ]);
    expect(trashRowRoute('users', GROUP, USER_ROW)).toEqual([
      '/groups',
      GROUP,
      'users',
      USER_ROW.id,
    ]);
    expect(trashRowRoute('groups', GROUP, GROUP_ROW)).toEqual([
      '/groups',
      GROUP_ROW.id,
      'settings',
    ]);
  });
});

describe('trashRowLabel', () => {
  it('names a user by username and the others by name', () => {
    expect(trashRowLabel('users', USER_ROW)).toBe('anna');
    expect(trashRowLabel('companies', COMPANY_ROW)).toBe('Alfa Srl');
    expect(trashRowLabel('groups', GROUP_ROW)).toBe('Gruppo Alfa');
  });
});

describe('platformIssue', () => {
  const error = (status: number, details: { field: string; issue: string }[] = []) =>
    new ApiError({ status, code: 'FORBIDDEN', message: 'x', details });

  it('maps the errors about the user itself', () => {
    expect(platformIssue(error(403))).toBe('forbidden');
    expect(platformIssue(error(404))).toBe('notFound');
    expect(platformIssue(error(409, [{ field: 'groups', issue: 'referenced' }]))).toBe('hasGroups');
  });

  it('leaves the other errors alone', () => {
    expect(platformIssue(error(409, [{ field: 'x', issue: 'referenced' }]))).toBeNull();
    expect(platformIssue(error(409))).toBeNull();
    expect(platformIssue(error(500))).toBeNull();
    expect(platformIssue(new Error('network'))).toBeNull();
  });
});
