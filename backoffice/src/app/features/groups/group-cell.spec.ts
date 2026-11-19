import { groupCell } from './group-cell';

const i18n = { t: (key: string) => key };
const ID = '665f1c2e9b1d4a0012ab34a1';

describe('groupCell', () => {
  it('shows the name with a link to the group', () => {
    expect(groupCell(i18n, { groupId: ID, groupName: 'Alfa' })).toEqual({ id: ID, label: 'Alfa' });
  });

  it('shows a dash with the link for a group without a text name', () => {
    expect(groupCell(i18n, { groupId: ID, groupName: '' })).toEqual({
      id: ID,
      label: 'CROSS_GROUP.NO_NAME',
    });
  });

  it('shows a dash without a link for a group that does not exist or a row without a group', () => {
    expect(groupCell(i18n, { groupId: ID, groupName: null })).toEqual({
      id: null,
      label: 'CROSS_GROUP.NO_NAME',
    });
    expect(groupCell(i18n, { groupId: null, groupName: null })).toEqual({
      id: null,
      label: 'CROSS_GROUP.NO_NAME',
    });
    expect(groupCell(i18n, {})).toEqual({ id: null, label: 'CROSS_GROUP.NO_NAME' });
  });

  it('falls back to the short id when the server gave no name', () => {
    expect(groupCell(i18n, { groupId: ID })).toEqual({ id: ID, label: '…ab34a1' });
  });
});
