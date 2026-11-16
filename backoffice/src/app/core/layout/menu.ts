import { InjectionToken } from '@angular/core';
import { IconName } from '../../shared/ui/icon/icons';
import { Role } from '../session/session.types';

/** A navigation entry of the side menu. */
export interface MenuItem {
  /** Stable identifier. */
  readonly id: string;
  /** Dictionary key of the label. */
  readonly labelKey: string;
  /** Icon shown before the label. */
  readonly icon: IconName;
  /** Router link of the entry. */
  readonly route: string;
  /** Permission required to see the entry (checked against the session, see `visibleMenu`). */
  readonly permission?: string;
  /** Roles that see the entry (any role when omitted). */
  readonly roles?: readonly Role[];
  /**
   * Page of the working group (`/groups/{id}/<groupPath>`); `route` is the fallback while a
   * PSA or dealer has not chosen a group.
   */
  readonly groupPath?: string;
  /** Feature (company/store module) that must be enabled to see the entry. */
  readonly feature?: string;
  /** Sub-entries; a group without any visible child is hidden. */
  readonly children?: readonly MenuItem[];
}

/** Menu configuration. Entries for each area are added by the steps that create their pages. */
export const MENU: readonly MenuItem[] = [
  { id: 'home', labelKey: 'MENU.HOME', icon: 'home', route: '/' },
  {
    id: 'profile',
    labelKey: 'MENU.PROFILE',
    icon: 'user',
    route: '/profile',
    permission: 'profile:read',
  },
  {
    id: 'users',
    labelKey: 'MENU.USERS',
    icon: 'users',
    route: '/users',
    groupPath: 'users',
    permission: 'users:read',
  },
  {
    id: 'platform-users',
    labelKey: 'MENU.PLATFORM_USERS',
    icon: 'users',
    route: '/platform/users',
    permission: 'users:read',
    roles: ['PSA'],
  },
  {
    id: 'dealers',
    labelKey: 'MENU.DEALERS',
    icon: 'building',
    route: '/dealers',
    permission: 'dealers:read',
    roles: ['PSA'],
  },
  {
    id: 'groups',
    labelKey: 'MENU.GROUPS',
    icon: 'building',
    route: '/groups/list',
    permission: 'groups:read',
    roles: ['PSA', 'D'],
  },
  {
    id: 'group-settings',
    labelKey: 'MENU.GROUP_SETTINGS',
    icon: 'settings',
    route: '/groups',
    groupPath: 'settings',
    permission: 'groups:read',
    roles: ['PSA', 'D'],
  },
  {
    id: 'account-group',
    labelKey: 'MENU.ACCOUNT_GROUP',
    icon: 'settings',
    route: '/groups',
    groupPath: 'settings',
    permission: 'groups:read',
    roles: ['SA'],
  },
  {
    id: 'companies',
    labelKey: 'MENU.COMPANIES',
    icon: 'building',
    route: '/groups',
    groupPath: 'companies',
    permission: 'companies:read',
  },
  {
    id: 'places',
    labelKey: 'MENU.PLACES',
    icon: 'store',
    route: '/groups',
    groupPath: 'places',
    permission: 'places:read',
  },
  {
    id: 'fidelity',
    labelKey: 'MENU.FIDELITY',
    icon: 'card',
    route: '/groups',
    groupPath: 'fidelity/card-types',
    children: [
      {
        id: 'card-types',
        labelKey: 'MENU.CARD_TYPES',
        icon: 'card',
        route: '/groups',
        groupPath: 'fidelity/card-types',
        permission: 'fidelity:read',
      },
      {
        id: 'points-collections',
        labelKey: 'MENU.POINTS_COLLECTIONS',
        icon: 'star',
        route: '/groups',
        groupPath: 'fidelity/points-collections',
        permission: 'fidelity:read',
      },
      {
        id: 'prize-catalogues',
        labelKey: 'MENU.PRIZE_CATALOGUES',
        icon: 'gift',
        route: '/groups',
        groupPath: 'fidelity/prize-catalogues',
        permission: 'fidelity:read',
      },
    ],
  },
  {
    id: 'products',
    labelKey: 'MENU.PRODUCTS',
    icon: 'tag',
    route: '/groups',
    groupPath: 'product-favorites',
    children: [
      {
        id: 'product-favorites',
        labelKey: 'MENU.PRODUCT_FAVORITES',
        icon: 'star',
        route: '/groups',
        groupPath: 'product-favorites',
        permission: 'products:read',
      },
    ],
  },
  {
    id: 'promotions',
    labelKey: 'MENU.PROMOTIONS',
    icon: 'tag',
    route: '/groups',
    groupPath: 'promotions',
    permission: 'products:read',
  },
  {
    id: 'activity-log',
    labelKey: 'MENU.ACTIVITY_LOG',
    icon: 'log',
    route: '/activity-log',
    permission: 'activityLog:read',
  },
];

/** Menu entries used by the shell; tests (or future steps) can provide a different set. */
export const MENU_ITEMS = new InjectionToken<readonly MenuItem[]>('MENU_ITEMS', {
  providedIn: 'root',
  factory: () => MENU,
});

/**
 * Filters the menu by permission, role and enabled feature. Pure: the predicates come from the caller.
 * A group whose children are all hidden is hidden too.
 *
 * @param items Menu configuration.
 * @param can Whether the current user holds a permission.
 * @param hasFeature Whether a feature is enabled for the current context.
 * @param role Role of the current user (if known), for entries limited to some roles.
 * @returns The visible entries (new objects where children were filtered).
 */
export function visibleMenu(
  items: readonly MenuItem[],
  can: (permission: string) => boolean,
  hasFeature: (feature: string) => boolean,
  role?: Role,
): MenuItem[] {
  const result: MenuItem[] = [];
  for (const item of items) {
    const allowed =
      (item.permission === undefined || can(item.permission)) &&
      (item.roles === undefined || (role !== undefined && item.roles.includes(role))) &&
      (item.feature === undefined || hasFeature(item.feature));
    if (!allowed) {
      continue;
    }
    if (item.children === undefined) {
      result.push(item);
      continue;
    }
    const children = visibleMenu(item.children, can, hasFeature, role);
    if (children.length > 0) {
      result.push({ ...item, children });
    }
  }
  return result;
}
