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
  /** Permissions of which the user must hold at least one to see the entry (alternative to `permission`). */
  readonly anyPermission?: readonly string[];
  /** Roles that see the entry (any role when omitted). */
  readonly roles?: readonly Role[];
  /**
   * Page of the working group (`/groups/{id}/<groupPath>`); `route` is the fallback while a
   * PSA or dealer has not chosen a group.
   */
  readonly groupPath?: string;
  /**
   * Cross-group list a PSA or dealer with no working group goes to, instead of the group chooser
   * that `route` is.
   */
  readonly allRoute?: string;
  /**
   * Whether the entry (and its children) is shown only while a working group is selected. PSA and
   * dealers must pick one; SA, CA and PA always have theirs.
   */
  readonly requiresGroup?: true;
  /**
   * Extra path patterns (`*` stands for one segment) on which the entry is the active one, for
   * pages that belong to it without sitting under its own link.
   */
  readonly alsoActiveFor?: readonly string[];
  /** Feature (company/store module) that must be enabled to see the entry. */
  readonly feature?: string;
  /** Whether the entry links to its first visible child (a group whose children are open to different roles): `route` is then only the fallback. */
  readonly linksToFirstChild?: true;
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
    id: 'dealers',
    labelKey: 'MENU.DEALERS',
    icon: 'building',
    route: '/dealers',
    permission: 'dealers:read',
    roles: ['PSA'],
  },
  {
    id: 'groups',
    // The record of a group is reached from the list, so the list stays the active entry.
    alsoActiveFor: ['/groups/*/settings'],
    labelKey: 'MENU.GROUPS',
    icon: 'building',
    route: '/groups/list',
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
    allRoute: '/companies',
    alsoActiveFor: ['/companies'],
    permission: 'companies:read',
  },
  {
    id: 'places',
    labelKey: 'MENU.PLACES',
    icon: 'store',
    route: '/groups',
    groupPath: 'places',
    allRoute: '/places',
    alsoActiveFor: ['/places'],
    permission: 'places:read',
  },
  {
    id: 'fidelity',
    requiresGroup: true,
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
    requiresGroup: true,
    labelKey: 'MENU.CATALOG',
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
      {
        id: 'products-list',
        labelKey: 'MENU.PRODUCTS_LIST',
        icon: 'tag',
        route: '/groups',
        groupPath: 'products',
        permission: 'products:read',
      },
      {
        id: 'services-list',
        labelKey: 'MENU.SERVICES_LIST',
        icon: 'tag',
        route: '/groups',
        groupPath: 'services',
        permission: 'products:read',
        feature: 'services',
      },
      {
        id: 'modifiers-list',
        labelKey: 'MENU.MODIFIERS_LIST',
        icon: 'tag',
        route: '/groups',
        groupPath: 'product-modifiers',
        permission: 'products:read',
        feature: 'productsVariants',
      },
      {
        id: 'tobacco-products-list',
        labelKey: 'MENU.TOBACCO_PRODUCTS_LIST',
        icon: 'tag',
        route: '/groups',
        groupPath: 'tobacco-products',
        permission: 'products:read',
        feature: 'tobaccosGamesMonopoly',
      },
      {
        id: 'product-categories',
        labelKey: 'MENU.PRODUCT_CATEGORIES',
        icon: 'tag',
        route: '/groups',
        groupPath: 'product-categories',
        permission: 'products:read',
      },
      {
        id: 'product-departments',
        labelKey: 'MENU.PRODUCT_DEPARTMENTS',
        icon: 'tag',
        route: '/groups',
        groupPath: 'product-departments',
        permission: 'products:read',
        feature: 'cash',
      },
      {
        id: 'product-brands',
        labelKey: 'MENU.PRODUCT_BRANDS',
        icon: 'tag',
        route: '/groups',
        groupPath: 'product-brands',
        permission: 'products:read',
      },
      {
        id: 'product-attribute-groups',
        labelKey: 'MENU.PRODUCT_ATTRIBUTES',
        icon: 'tag',
        route: '/groups',
        groupPath: 'product-attribute-groups',
        permission: 'products:read',
      },
    ],
  },
  {
    id: 'promotions',
    requiresGroup: true,
    labelKey: 'MENU.PROMOTIONS',
    icon: 'tag',
    route: '/groups',
    groupPath: 'promotions',
    permission: 'products:read',
  },
  {
    id: 'activations',
    labelKey: 'MENU.ACTIVATIONS',
    icon: 'log',
    route: '/activations',
    permission: 'activations:read',
    roles: ['PSA', 'D'],
  },
  {
    id: 'tools',
    labelKey: 'MENU.TOOLS',
    // Not 'settings': that icon belongs to the "Impostazioni" entry shown to the same role.
    icon: 'more',
    route: '/tools/new-customer',
    linksToFirstChild: true,
    children: [
      {
        id: 'new-customer',
        labelKey: 'MENU.NEW_CUSTOMER',
        icon: 'plus',
        route: '/tools/new-customer',
        permission: 'groups:create',
        roles: ['PSA', 'D'],
      },
      {
        id: 'diagnostics',
        labelKey: 'MENU.DIAGNOSTICS',
        icon: 'log',
        route: '/tools/diagnostics',
        permission: 'places:read',
      },
      {
        id: 'error-documents',
        labelKey: 'MENU.ERROR_DOCUMENTS',
        icon: 'alert',
        route: '/tools/error-documents',
        permission: 'errorDocuments:read',
        roles: ['PSA', 'D'],
      },
      {
        id: 'tobaccos',
        labelKey: 'MENU.TOBACCOS',
        icon: 'tag',
        route: '/tools/tobaccos',
        permission: 'tobaccos:read',
        roles: ['PSA'],
      },
      {
        id: 'email-templates',
        labelKey: 'MENU.EMAIL_TEMPLATES',
        icon: 'mail',
        route: '/groups',
        groupPath: 'email-templates',
        permission: 'places:read',
        feature: 'email',
      },
    ],
  },
  {
    id: 'settings',
    labelKey: 'MENU.SETTINGS',
    icon: 'settings',
    route: '/settings/price-list',
    linksToFirstChild: true,
    children: [
      {
        id: 'price-list',
        labelKey: 'MENU.PRICE_LIST',
        icon: 'tag',
        route: '/settings/price-list',
        permission: 'activations:manage',
        roles: ['PSA'],
      },
      {
        id: 'countries',
        labelKey: 'MENU.COUNTRIES',
        icon: 'settings',
        route: '/settings/countries',
        permission: 'countries:manage',
        roles: ['PSA'],
      },
    ],
  },
  {
    id: 'releases',
    labelKey: 'MENU.RELEASES',
    icon: 'release',
    route: '/releases',
    roles: ['PSA', 'D'],
  },
  {
    id: 'trash',
    labelKey: 'MENU.TRASH',
    icon: 'trash',
    route: '/groups',
    groupPath: 'trash',
    allRoute: '/trash',
    alsoActiveFor: ['/trash'],
    anyPermission: ['companies:read', 'places:read', 'users:read'],
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
 * Filters the menu by permission, role, enabled feature and working group. Pure: the predicates come from the caller.
 * A group whose children are all hidden is hidden too.
 *
 * @param items Menu configuration.
 * @param can Whether the current user holds a permission.
 * @param hasFeature Whether a feature is enabled for the current context.
 * @param role Role of the current user (if known), for entries limited to some roles.
 * @param hasGroup Whether a working group is selected (entries with `requiresGroup` need it).
 * @returns The visible entries (new objects where children were filtered).
 */
export function visibleMenu(
  items: readonly MenuItem[],
  can: (permission: string) => boolean,
  hasFeature: (feature: string) => boolean,
  role?: Role,
  hasGroup = true,
): MenuItem[] {
  const result: MenuItem[] = [];
  for (const item of items) {
    const allowed =
      (item.permission === undefined || can(item.permission)) &&
      (item.anyPermission === undefined || item.anyPermission.some(can)) &&
      (item.roles === undefined || (role !== undefined && item.roles.includes(role))) &&
      (item.feature === undefined || hasFeature(item.feature)) &&
      (item.requiresGroup === undefined || hasGroup);
    if (!allowed) {
      continue;
    }
    if (item.children === undefined) {
      result.push(item);
      continue;
    }
    const children = visibleMenu(item.children, can, hasFeature, role, hasGroup);
    if (children.length > 0) {
      result.push({
        ...item,
        children,
        ...(item.linksToFirstChild === true ? { route: children[0]!.route } : {}),
      });
    }
  }
  return result;
}

/** Path of the group chooser, the fallback link of the group pages while no group is selected. */
const CHOOSER_PATH = '/groups';

/** Pages of a working group the menu can point to (`groupPath` values): the only valid `to`. */
export const GROUP_TARGETS: ReadonlySet<string> = new Set(
  MENU.flatMap((item) => [item, ...(item.children ?? [])]).flatMap((item) =>
    item.groupPath === undefined ? [] : [item.groupPath],
  ),
);

/**
 * Page the user wanted when they landed on the group chooser (`/groups?to=companies`), or `null`
 * when the URL is not the chooser or `to` is not exactly one of {@link GROUP_TARGETS}.
 */
export function chooserTarget(url: string): string | null {
  const [location = '', query = ''] = url.split('#')[0]!.split('?');
  if (segmentsOf(location).join('/') !== 'groups') {
    return null;
  }
  const to = new URLSearchParams(query).get('to');
  return to !== null && GROUP_TARGETS.has(to) ? to : null;
}

/** Segments of a path without query string, fragment or empty parts. */
function segmentsOf(path: string): string[] {
  return path
    .split(/[?#]/)[0]!
    .split('/')
    .filter((part) => part !== '');
}

/**
 * Length (in segments) of the pattern when it matches the start of the path, `-1` otherwise. A
 * `*` segment matches any one segment. With `exact` the whole path must match.
 */
function matchLength(pattern: string, path: string[], exact: boolean): number {
  const parts = segmentsOf(pattern);
  const fits =
    parts.length <= path.length &&
    (!exact || parts.length === path.length) &&
    parts.every((part, index) => part === '*' || part === path[index]);
  return fits ? parts.length : -1;
}

/**
 * Ids of the leaf entries to show as the current page for a URL: the entries whose link (or
 * `alsoActiveFor` pattern) matches the longest start of the path. The most specific match wins,
 * so two unrelated entries are never active together. Entries with children never are (see
 * {@link activeParentIds}). The home link and the `/groups` chooser, which is also the fallback of
 * every group page while no group is selected, match only their own page.
 *
 * @param items Visible entries (children included are looked at).
 * @param linkOf Router link of an entry, as rendered.
 * @param url Current URL.
 */
export function activeMenuIds(
  items: readonly MenuItem[],
  linkOf: (item: MenuItem) => string,
  url: string,
): Set<string> {
  const path = segmentsOf(url);
  const chooser = chooserTarget(url);
  const matches: { id: string; length: number }[] = [];
  const visit = (entries: readonly MenuItem[]): void => {
    for (const item of entries) {
      if (item.children !== undefined) {
        // A parent is never the current page, even when it links to its first child.
        visit(item.children);
        continue;
      }
      const link = linkOf(item);
      const exact = link === '/' || link === CHOOSER_PATH;
      // On the chooser the entry that sent the user there is the only active one.
      const onChooser = link === CHOOSER_PATH ? chooser === item.groupPath : true;
      const lengths = [
        onChooser ? matchLength(link, path, exact) : -1,
        // The pages of a group of the menu (`/groups/:id/<groupPath>`) belong to the entry
        // whichever the working group is: a record of another group is opened without
        // selecting its group.
        ...(item.alsoActiveFor ?? []).map((pattern) => matchLength(pattern, path, false)),
        ...(item.groupPath === undefined
          ? []
          : [matchLength(`/groups/*/${item.groupPath}`, path, false)]),
      ];
      matches.push({ id: item.id, length: Math.max(...lengths) });
    }
  };
  visit(items);
  const best = Math.max(0, ...matches.map((match) => match.length));
  return new Set(
    matches.filter((match) => match.length >= 0 && match.length === best).map((m) => m.id),
  );
}

/**
 * Ids of the entries with children that contain an active entry: shown with a lighter "has an
 * active child" state, the same whichever child is the active one.
 *
 * @param items Visible entries.
 * @param active Ids returned by {@link activeMenuIds}.
 */
export function activeParentIds(
  items: readonly MenuItem[],
  active: ReadonlySet<string>,
): Set<string> {
  return new Set(
    items
      .filter((item) => item.children?.some((child) => active.has(child.id)))
      .map((item) => item.id),
  );
}
