import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  input,
  linkedSignal,
  output,
  Signal,
  signal,
} from '@angular/core';
import {
  disabled,
  FieldTree,
  form,
  FormField,
  maxLength,
  SchemaPath,
  required,
  submit,
  validate,
} from '@angular/forms/signals';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { ReferenceApi } from '../../../core/reference/reference-api';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { Select, SelectOption } from '../../../shared/ui/select/select';
import { TabItem, TabList } from '../../../shared/ui/tab-list/tab-list';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { ReferencePicker } from '../../users/reference-picker';
import { MAX_PROMOTION_IDS, Promotion } from './catalog.types';
import { editorErrors } from './catalog-errors';
import { PlacePerimeter } from './place-perimeter';
import {
  AMOUNT_TAXES,
  createBody,
  DISCOUNT_TYPES,
  DISCOUNT_VALUE_TYPES,
  modelOf,
  patchBody,
  PROMOTION_FIELDS,
  PROMOTION_KEYS,
  PROMOTION_SECTIONS,
  PromotionModel,
  promotionIssue,
  PromotionSection,
  SELECTIONS,
} from './promotion-model';
import { lookupLoader, placesLoader, selectionNames } from './reference-loaders';

/** Lists of the form that hold ids of the group. */
const LIST_KEYS: readonly (keyof PromotionModel)[] = [
  'placeIds',
  'customerIds',
  'contactGroupIds',
  'productIds',
  'categoryIds',
  'actionProductIds',
  'actionCategoryIds',
];

/**
 * Form of a promotion, in four sections that share one save (like the user record): general data,
 * conditions (stores, validity, customers, limits, amounts and exclusions), products and
 * categories the cart must hold, and the actions (the discount). The form edits the whole model
 * of the promotion; on modification only the fields that changed are sent. A company or store
 * administrator may not leave the stores empty (the whole group): the selector lists only their
 * stores.
 */
@Component({
  selector: 'fc-promotion-editor',
  imports: [
    Button,
    Checkbox,
    FormError,
    FormField,
    ReferencePicker,
    Select,
    TabList,
    Textarea,
    TextField,
    TPipe,
  ],
  templateUrl: './promotion-editor.html',
  styleUrls: ['./catalog-editor.css', './promotion-editor.css'],
})
export class PromotionEditor {
  protected readonly i18n = inject(I18nService);
  private readonly reference = inject(ReferenceApi);
  private readonly injector = inject(Injector);
  protected readonly perimeter = inject(PlacePerimeter);

  /** Group the promotion belongs to. */
  readonly groupId = input.required<string>();
  /** The promotion being changed; `null` to create one. */
  readonly item = input<Promotion | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** Shows the element for reading only: every field is disabled and nothing can be saved. */
  readonly readOnly = input(false);
  /** The body to send. */
  readonly save = output<Record<string, unknown>>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal<PromotionModel>(() => modelOf(this.item()));
  protected readonly promoForm = form(this.model, (path) => {
    disabled(path, () => this.readOnly());
    required(path.name);
    maxLength(path.name, 200);
    maxLength(path.description, 1000);
    maxLength(path.code, 50);
    for (const key of PROMOTION_KEYS) {
      if (!LIST_KEYS.includes(key)) {
        validate(path[key] as SchemaPath<string>, ({ valueOf }) => {
          const kind = promotionIssue(valueOf(path), key);
          return kind === undefined ? undefined : { kind };
        });
      }
    }
    for (const key of LIST_KEYS) {
      validate(path[key] as SchemaPath<string[]>, ({ value }) =>
        value().length > MAX_PROMOTION_IDS ? { kind: 'tooMany' } : undefined,
      );
    }
    validate(path.placeIds, ({ value }) =>
      this.perimeter.restricted() && value().length === 0 ? { kind: 'required' } : undefined,
    );
  });

  protected readonly section = signal<PromotionSection>('general');
  protected readonly tabs = computed<TabItem[]>(() => {
    const counts = this.errorCounts();
    return PROMOTION_SECTIONS.map((id) => ({
      id,
      label: this.i18n.t(`CATALOG.PROMOTIONS.SECTION.${id.toUpperCase()}`),
      errors: counts[id],
    }));
  });

  // Choices.
  protected readonly amountTaxOptions = this.options(AMOUNT_TAXES, 'AMOUNT_TAX', true);
  protected readonly selectionOptions = this.options(SELECTIONS, 'SELECTION', true);
  protected readonly categorySelectionOptions = this.options(['only_n'], 'SELECTION', true);
  protected readonly discountTypeOptions = this.options(DISCOUNT_TYPES, 'DISCOUNT_TYPE', true);
  protected readonly discountValueTypeOptions = this.options(
    DISCOUNT_VALUE_TYPES,
    'DISCOUNT_VALUE_TYPE',
    false,
  );

  // Selectors: loaders, and the names of what the promotion already holds.
  protected readonly placeLoader = computed(() => placesLoader(this.reference, this.groupId()));
  protected readonly customerLoader = computed(() =>
    lookupLoader(this.reference, this.groupId(), 'customers'),
  );
  protected readonly contactGroupLoader = computed(() =>
    lookupLoader(this.reference, this.groupId(), 'contact-groups'),
  );
  protected readonly productLoader = computed(() =>
    lookupLoader(this.reference, this.groupId(), 'products'),
  );
  protected readonly categoryLoader = computed(() =>
    lookupLoader(this.reference, this.groupId(), 'product-categories'),
  );
  protected readonly placeLabels = selectionNames(
    () => this.item()?.conditions.placeIds ?? [],
    (ids) => this.reference.placeNames(this.groupId(), ids),
  );
  protected readonly customerLabels = selectionNames(
    () => this.item()?.conditions.customerIds ?? [],
    (ids) => this.reference.lookupNames(this.groupId(), 'customers', ids),
  );
  protected readonly contactGroupLabels = selectionNames(
    () => this.item()?.conditions.contactGroupIds ?? [],
    (ids) => this.reference.lookupNames(this.groupId(), 'contact-groups', ids),
  );
  protected readonly productLabels = selectionNames(
    () => [
      ...(this.item()?.conditions.products.productIds ?? []),
      ...(this.item()?.actions.productIds ?? []),
    ],
    (ids) => this.reference.lookupNames(this.groupId(), 'products', ids),
  );
  protected readonly categoryLabels = selectionNames(
    () => [
      ...(this.item()?.conditions.categories.categoryIds ?? []),
      ...(this.item()?.actions.categoryIds ?? []),
    ],
    (ids) => this.reference.lookupNames(this.groupId(), 'product-categories', ids),
  );

  private readonly errors = computed(() =>
    editorErrors(
      this.i18n,
      this.error(),
      PROMOTION_KEYS.map((key) => PROMOTION_FIELDS[key].path),
    ),
  );
  protected readonly formError = computed(() => this.errors().form);

  /** Errors of each section: those of the server, and the client ones of the fields already touched. */
  protected readonly errorCounts = computed(() => {
    const counts: Record<PromotionSection, number> = {
      general: 0,
      conditions: 0,
      products: 0,
      actions: 0,
    };
    for (const key of PROMOTION_KEYS) {
      const { section, path } = PROMOTION_FIELDS[key];
      const state = this.promoForm[key]();
      if (
        Object.hasOwn(this.errors().fields, path) ||
        (state.touched() && state.errors().length > 0)
      ) {
        counts[section]++;
      }
    }
    return counts;
  });

  protected readonly body = computed(() => {
    const item = this.item();
    return item === null ? createBody(this.model()) : patchBody(this.model(), modelOf(item));
  });
  protected readonly hasChanges = computed(
    () => this.item() === null || Object.keys(this.body()).length > 0,
  );

  /** Message of a field: its client validation first, then what the server said about it. */
  protected msg(key: keyof PromotionModel): string | null {
    return (
      fieldErrorMessage(this.i18n, (this.promoForm[key] as FieldTree<unknown>)()) ??
      this.errors().fields[PROMOTION_FIELDS[key].path] ??
      null
    );
  }

  protected select(id: string): void {
    this.section.set(id as PromotionSection);
  }

  protected touch(field: FieldTree<unknown>): void {
    field().markAsTouched();
  }

  private options<T extends string>(
    values: readonly T[],
    group: string,
    withNone: boolean,
  ): Signal<SelectOption[]> {
    return computed(() => {
      const options = values.map((value) => ({
        value,
        label: this.i18n.t(`CATALOG.PROMOTIONS.${group}.${value.toUpperCase()}`),
      }));
      return withNone
        ? [{ value: '', label: this.i18n.t('CATALOG.PROMOTIONS.NONE') }, ...options]
        : options;
    });
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.readOnly()) {
      return;
    }
    await submit(this.promoForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => {
        // An invalid form always has an invalid field, and every field belongs to a section.
        const first = PROMOTION_SECTIONS.find((id) =>
          PROMOTION_KEYS.some(
            (key) =>
              PROMOTION_FIELDS[key].section === id && this.promoForm[key]().errors().length > 0,
          ),
        ) as PromotionSection;
        this.section.set(first);
        // The panel of the section is shown by the next render: focus the field after it.
        afterNextRender(() => focusFirstError(this.promoForm), { injector: this.injector });
      },
    });
  }
}
