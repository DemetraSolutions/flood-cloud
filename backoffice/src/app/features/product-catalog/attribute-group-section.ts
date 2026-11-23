import {
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  resource,
  signal,
} from '@angular/core';
import {
  disabled,
  form,
  FormField,
  ReadonlyFieldTree,
  submit,
  TreeValidationResult,
  validateTree,
} from '@angular/forms/signals';
import { ApiError } from '../../core/api/api-error';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Icon } from '../../shared/ui/icon/icon';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { uniqueId } from '../../shared/ui/unique-id';
import { isStale, resolveField } from '../companies/company-errors';
import { languageName } from '../groups/languages';
import {
  allLanguages,
  attributeLanguages,
  attributesBody,
  attributesChanged,
  AttributesModel,
  toAttributesModel,
} from './attribute-model';
import { textIssues } from './catalog-item-texts';
import { ProductCatalogApi } from './product-catalog-api';
import {
  BlockedBy,
  deleteFailureMessage,
  isReferenced,
  productNames,
} from './product-catalog-errors';
import {
  ATTRIBUTE_GROUPS_SEGMENT,
  AttributeGroup,
  CATALOG_LIMITS,
  textOf,
  Versioned,
} from './product-catalog.types';

/**
 * One group of attributes as an expandable section of the page of the attributes: a button with
 * the name of the group that opens a panel with its attributes (a name for each language, and
 * "remove"), a row to add one, and the save of the whole list with the version of the group in
 * `If-Match`. The group is read in full when the section is first opened (the list does not give
 * its version). A `409` that lists products names them; a concurrent change asks to reload.
 */
@Component({
  selector: 'fc-attribute-group-section',
  imports: [Button, ConfirmDialog, FormError, FormField, Icon, TextField, TPipe],
  templateUrl: './attribute-group-section.html',
  styleUrl: './attribute-group-section.css',
})
export class AttributeGroupSection {
  private readonly api = inject(ProductCatalogApi);
  private readonly reference = inject(ReferenceApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  /** Group of the attributes, and the group of the page. */
  readonly groupId = input.required<string>();
  /** The group of attributes as the list gives it. */
  readonly group = input.required<AttributeGroup>();
  /** Languages of the group of the customer. */
  readonly languages = input.required<readonly string[]>();
  /** The language every name must be given in when it has no other. */
  readonly required = input.required<string>();
  /** Whether the user may change the group (the roles that write attributes, with `products:update`). */
  readonly writable = input.required<boolean>();
  /** Emitted once the group was deleted. */
  readonly deleted = output<string>();

  protected readonly panelId = uniqueId('fc-attribute-group');
  protected readonly expanded = signal(false);
  /** Whether the section was ever opened: the group is read once, and closing keeps what was typed. */
  private readonly opened = signal(false);

  private readonly loaded = resource({
    params: () =>
      this.opened() ? { groupId: this.groupId(), id: this.group().id } : undefined,
    loader: ({ params }) =>
      this.api.read<AttributeGroup>(params.groupId, ATTRIBUTE_GROUPS_SEGMENT, params.id),
  });
  /** The group as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<Versioned<AttributeGroup> | undefined, Versioned<AttributeGroup> | null>({
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly current = computed(() => this.saved()?.item ?? this.group());
  protected readonly loading = computed(() => this.loaded.isLoading());
  protected readonly loadFailed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadErrorMessage = computed(() =>
    failureMessage(this.i18n, this.loaded.error()),
  );
  protected readonly title = computed(() =>
    textOf(this.current().name, this.i18n.language() ?? DEFAULT_LANGUAGE),
  );
  protected readonly formLanguages = computed(() =>
    attributeLanguages(this.current(), this.languages()),
  );

  protected readonly model = linkedSignal<AttributesModel>(() =>
    toAttributesModel(this.current(), this.formLanguages()),
  );
  protected readonly attributesForm = form(this.model, (path) => {
    validateTree(path, ({ value, fieldTree }) =>
      value().attributes.flatMap((row, index) =>
        textIssues(row.name, {}, this.required(), false).map((problem) => ({
          kind: problem.issue,
          fieldTree: fieldTree.attributes[index].name[problem.language],
        })),
      ),
    );
    disabled(path, () => !this.writable());
  });
  protected readonly unsaved = computed(() => {
    const saved = this.saved();
    return saved !== null && attributesChanged(this.model(), saved.item.attributes);
  });
  protected readonly atLimit = computed(
    () => this.model().attributes.length >= CATALOG_LIMITS.attributes,
  );

  // The row to add an attribute.
  protected readonly newName = signal<Record<string, string>>({});
  protected readonly newProblem = signal(false);

  protected readonly failure = signal<string | null>(null);
  /** The version read is no longer the current one: the section offers to read again. */
  protected readonly stale = signal(false);
  protected readonly blocked = signal<BlockedBy | null>(null);
  protected readonly submitting = computed(() => this.attributesForm().submitting());

  // Deletion of the group.
  protected readonly confirmOpen = signal(false);
  protected readonly busy = signal(false);

  protected toggle(): void {
    this.opened.set(true);
    this.expanded.update((open) => !open);
  }

  protected languageLabel(code: string): string {
    return languageName(code, this.i18n.language() ?? DEFAULT_LANGUAGE);
  }

  protected rowLabel(index: number): string {
    return this.i18n.t('PRODUCT_CATALOG.ATTRIBUTES.ROW', { number: index + 1 });
  }

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected newValue(code: string): string {
    return this.newName()[code] ?? '';
  }

  protected setNew(code: string, text: string): void {
    this.newProblem.set(false);
    this.newName.update((current) => ({ ...current, [code]: text }));
  }

  protected add(): void {
    const texts = allLanguages(this.newName(), this.formLanguages());
    if (textIssues(texts, {}, this.required(), false).length > 0) {
      this.newProblem.set(true);
      return;
    }
    this.model.update((current) => ({
      attributes: [...current.attributes, { id: '', name: texts }],
    }));
    this.newName.set({});
  }

  protected remove(index: number): void {
    this.model.update((current) => ({
      attributes: current.attributes.filter((_, at) => at !== index),
    }));
  }

  protected reload(): void {
    this.stale.set(false);
    this.failure.set(null);
    this.blocked.set(null);
    this.loaded.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.attributesForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        this.blocked.set(null);
        try {
          const result = await this.api.update<AttributeGroup>(
            this.groupId(),
            ATTRIBUTE_GROUPS_SEGMENT,
            this.group().id,
            attributesBody(this.model()),
            (this.saved() as Versioned<AttributeGroup>).etag,
          );
          this.saved.set(result);
        } catch (error) {
          return this.reject(error);
        }
        this.toast.success(this.i18n.t('PRODUCT_CATALOG.ATTRIBUTES.SAVED', { name: this.title() }));
        return undefined;
      },
      onInvalid: () => focusFirstError(this.attributesForm),
    });
  }

  protected async delete(): Promise<void> {
    this.busy.set(true);
    const name = this.title();
    try {
      await this.api.remove(this.groupId(), ATTRIBUTE_GROUPS_SEGMENT, this.group().id);
    } catch (error) {
      await this.refuse(error, name);
      return;
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
    this.toast.success(this.i18n.t('PRODUCT_CATALOG.ATTRIBUTES.DELETE.DONE', { name }));
    this.deleted.emit(this.group().id);
  }

  /** A refused deletion: the products that use the attributes, or the reason. */
  private async refuse(error: unknown, name: string): Promise<void> {
    if (isReferenced(error)) {
      this.blocked.set({
        entry: name,
        products: await productNames(this.reference, this.groupId(), error),
      });
    } else {
      this.toast.error(deleteFailureMessage(this.i18n, error));
    }
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('PRODUCT_CATALOG.ATTRIBUTES.STALE'));
      return undefined;
    }
    if (isReferenced(error)) {
      void this.refuse(error, this.title());
      return undefined;
    }
    if (error instanceof ApiError && error.code === 'VALIDATION_ERROR' && error.details.length > 0) {
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
      for (const { field } of error.details) {
        const found = resolveField(this.attributesForm, field);
        if (found !== undefined) {
          fields[field] = found;
        }
      }
      const mapped = serverFieldErrors(this.i18n, error, fields);
      if (mapped.unmatched) {
        this.failure.set(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
      }
      return mapped.errors;
    }
    if (error instanceof ApiError && error.code === 'CONFLICT') {
      this.stale.set(true);
      this.failure.set(this.i18n.t('PRODUCT_CATALOG.ERROR.CONCURRENT'));
    } else if (error instanceof ApiError && error.code === 'FORBIDDEN') {
      this.failure.set(this.i18n.t('PRODUCT_CATALOG.ERROR.ATTRIBUTES_FORBIDDEN'));
    } else {
      this.failure.set(failureMessage(this.i18n, error));
    }
    return undefined;
  }
}
