import { InjectionToken } from '@angular/core';
import { IconName } from '../../shared/ui/icon/icons';

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
  /** Feature (company/store module) that must be enabled to see the entry. */
  readonly feature?: string;
  /** Sub-entries; a group without any visible child is hidden. */
  readonly children?: readonly MenuItem[];
}

/** Menu configuration. Entries for each area are added by the steps that create their pages. */
export const MENU: readonly MenuItem[] = [
  { id: 'home', labelKey: 'MENU.HOME', icon: 'home', route: '/' },
];

/** Menu entries used by the shell; tests (or future steps) can provide a different set. */
export const MENU_ITEMS = new InjectionToken<readonly MenuItem[]>('MENU_ITEMS', {
  providedIn: 'root',
  factory: () => MENU,
});

/**
 * Predicate that allows everything. It is used for both `can` and `hasFeature` until the
 * session (task 3.5.4) and the enabled features (task 4.5.2) exist: then the shell passes the
 * real predicates to {@link visibleMenu}.
 */
export function allowAll(_value: string): boolean {
  return true;
}

/**
 * Filters the menu by permission and enabled feature. Pure: the predicates come from the caller.
 * A group whose children are all hidden is hidden too.
 *
 * @param items Menu configuration.
 * @param can Whether the current user holds a permission.
 * @param hasFeature Whether a feature is enabled for the current context.
 * @returns The visible entries (new objects where children were filtered).
 */
export function visibleMenu(
  items: readonly MenuItem[],
  can: (permission: string) => boolean,
  hasFeature: (feature: string) => boolean,
): MenuItem[] {
  const result: MenuItem[] = [];
  for (const item of items) {
    const allowed =
      (item.permission === undefined || can(item.permission)) &&
      (item.feature === undefined || hasFeature(item.feature));
    if (!allowed) {
      continue;
    }
    if (item.children === undefined) {
      result.push(item);
      continue;
    }
    const children = visibleMenu(item.children, can, hasFeature);
    if (children.length > 0) {
      result.push({ ...item, children });
    }
  }
  return result;
}
