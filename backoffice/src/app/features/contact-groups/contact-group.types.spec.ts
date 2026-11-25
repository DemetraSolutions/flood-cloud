import { CONTACT_GROUP_LIMITS, contactGroupRoute } from './contact-group.types';

describe('contactGroupRoute', () => {
  it('points at the list, at a group of contacts and at the page of a new one', () => {
    expect(contactGroupRoute('g1')).toEqual(['/groups', 'g1', 'contact-groups']);
    expect(contactGroupRoute('g1', 'cg1')).toEqual(['/groups', 'g1', 'contact-groups', 'cg1']);
    expect(contactGroupRoute('g1', null)).toEqual(['/groups', 'g1', 'contact-groups', 'new']);
  });

  it('keeps the limit of the name of the server', () => {
    expect(CONTACT_GROUP_LIMITS.name).toBe(100);
  });
});
