import { booleanAttribute, Component, computed, ElementRef, inject, input, model } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { Button } from '../../shared/ui/button/button';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { withCurrent } from '../companies/company-options';
import { selectionNames } from '../groups/catalogs/reference-loaders';
import { FlatNode, nodeName } from '../product-categories/category.types';
import { ReferenceLoader, ReferencePicker } from '../users/reference-picker';
import { ChoiceRow, choiceIssues, MenuRow, menuIssues } from './product-model';
import { CHOICE_PRICE_RULES, PRODUCT_LIMITS } from './product.types';

/** The two kinds of group of choices: the ones of a menu and the ones of modifiers. */
export type ChoiceKind = 'menu' | 'choices';

/** A group of choices of either kind, for the template. */
type GroupRow = MenuRow | ChoiceRow;

/**
 * The groups of choices of a product: of a menu (a number of products of a category, in a course
 * with `rooms`) or of modifiers (a category, how many are free and which price the group charges).
 * A group lists the products the customer can choose from; without any, the choice is among the
 * products of the category. It implements the Signal Forms value control contract (`value`,
 * `disabled`), so it binds to the `MenuRow[]` or `ChoiceRow[]` of the form model.
 */
@Component({
  selector: 'fc-product-menu',
  imports: [Button, ReferencePicker, Select, TextField, TPipe],
  templateUrl: './product-menu.html',
  styleUrl: './product-section.css',
})
export class ProductMenu {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly reference = inject(ReferenceApi);
  private readonly i18n = inject(I18nService);

  readonly groupId = input.required<string>();
  /** Which groups the control edits. */
  readonly kind = input.required<ChoiceKind>();
  /** The groups (two-way). */
  readonly value = model<GroupRow[]>([]);
  /** The categories of the tree, in reading order. */
  readonly entries = input.required<readonly FlatNode[]>();
  /** The group has `rooms`: a menu group has a course. */
  readonly rooms = input(false);
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-product-menu');
  protected readonly errorId = `${this.id}-error`;
  protected readonly limit = PRODUCT_LIMITS.menuGroups;
  /** One loader for each category (a stable function, so that a picker is not reloaded when the page draws again). */
  private readonly loaders = new Map<string, ReferenceLoader>();
  private readonly names = selectionNames(
    () => this.value().flatMap((row) => row.productIds),
    (ids) => this.reference.lookupNames(this.groupId(), 'products', ids, this.kind() === 'choices'),
  );
  protected readonly labels = this.names;
  protected readonly priceRules = computed<SelectOption[]>(() =>
    CHOICE_PRICE_RULES.map((rule) => ({ value: rule, label: this.i18n.t(`PRODUCTS.CHOICES.RULE_${rule.toUpperCase()}`) })),
  );
  private readonly categories = computed<SelectOption[]>(() =>
    this.entries().map(({ node, level }) => ({
      value: node.id,
      label: `${'– '.repeat(level)}${nodeName(node, this.i18n.t('PRODUCT_CATEGORIES.NO_NAME'))}`,
    })),
  );
  protected readonly groups = computed(() =>
    this.value().map((row, index) => ({
      row,
      index,
      categories: withCurrent(this.categories(), row.categoryId, (id) => id),
      issues: (this.kind() === 'menu' ? menuIssues(row as MenuRow) : choiceIssues(row as ChoiceRow)) as Record<string, string | undefined>,
    })),
  );

  /** The loader of the products of a category (the modifiers for a group of modifier choices); a group without a category offers none to search. */
  protected loaderFor(categoryId: string): ReferenceLoader {
    const key = `${this.groupId()}/${this.kind()}/${categoryId}`;
    let loader = this.loaders.get(key);
    if (loader === undefined) {
      const groupId = this.groupId();
      const modifier = this.kind() === 'choices';
      loader = (query) => this.reference.lookup(groupId, 'products', { ...query, modifier, categoryId });
      this.loaders.set(key, loader);
    }
    return loader;
  }

  /** Focuses the first field (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLElement>('select, input')?.focus();
  }

  protected message(issue: string | undefined): string | null {
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  protected add(): void {
    const row: GroupRow =
      this.kind() === 'menu'
        ? { categoryId: '', quantity: '1', course: '', productIds: [] }
        : { categoryId: '', freeQuantity: '0', priceRule: 'highest', productIds: [] };
    this.value.update((rows) => [...rows, row]);
  }

  protected remove(index: number): void {
    this.value.update((rows) => rows.filter((_, position) => position !== index));
  }

  protected change(index: number, change: Partial<MenuRow & ChoiceRow>): void {
    this.value.update((rows) => rows.map((row, position) => (position === index ? { ...row, ...change } : row)));
  }

  protected menuOf(row: GroupRow): MenuRow {
    return row as MenuRow;
  }

  protected choiceOf(row: GroupRow): ChoiceRow {
    return row as ChoiceRow;
  }
}
