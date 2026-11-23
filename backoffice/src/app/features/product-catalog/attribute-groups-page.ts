import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import {
  form,
  FormField,
  ReadonlyFieldTree,
  submit,
  TreeValidationResult,
  validateTree,
} from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { resolveField } from '../companies/company-errors';
import { RecordGroup } from '../groups/record-group';
import { languageName } from '../groups/languages';
import { apiErrorOf } from '../profile/sessions';
import { allLanguages, filledTexts } from './attribute-model';
import { AttributeGroupSection } from './attribute-group-section';
import { textIssues } from './catalog-item-texts';
import { ProductCatalogApi } from './product-catalog-api';
import {
  ATTRIBUTE_GROUPS_SEGMENT,
  AttributeGroup,
  FALLBACK_LANGUAGE,
  requiredLanguage,
} from './product-catalog.types';

/** Groups read in one request. */
const PAGE_SIZE = 100;

/** The roles that write the attribute groups (the others read them only). */
const WRITERS: readonly string[] = ['PSA', 'D', 'SA'];

/**
 * The attributes of the products of a group (`/groups/:groupId/product-attribute-groups`), on
 * one page as in the legacy backoffice: a form to create a group of attributes on top and, below,
 * the groups as expandable sections, each with its attributes. Writing needs `products:update`
 * and a platform, dealer or account administrator role: company and store administrators see the
 * page read only.
 */
@Component({
  selector: 'fc-attribute-groups-page',
  imports: [
    AttributeGroupSection,
    Button,
    ErrorState,
    FormError,
    FormField,
    RecordGroup,
    TextField,
    TPipe,
  ],
  templateUrl: './attribute-groups-page.html',
  styleUrl: './attribute-groups-page.css',
})
export class AttributeGroupsPage {
  private readonly http = inject(HttpClient);
  private readonly api = inject(ProductCatalogApi);
  private readonly session = inject(SessionService);
  private readonly toast = inject(ToastService);
  private readonly key = new IdempotencyKey();
  protected readonly i18n = inject(I18nService);

  /** Route parameter (bound by the router). */
  readonly groupId = input.required<string>();

  protected readonly writable = computed(() => {
    const role = this.session.me()?.role;
    return this.session.can('products:update') && role !== undefined && WRITERS.includes(role);
  });

  private readonly first = httpResource<ApiPage<AttributeGroup>>(() => ({
    url: this.api.baseUrl(this.groupId(), ATTRIBUTE_GROUPS_SEGMENT),
    params: { limit: PAGE_SIZE, sort: 'name' },
  }));
  /** Groups read after the first page ("show more"). */
  private readonly more = signal<readonly AttributeGroup[]>([]);
  private readonly moreNext = signal<string | null | undefined>(undefined);
  protected readonly loadingMore = signal(false);
  protected readonly moreFailure = signal<string | null>(null);
  private readonly removed = signal<ReadonlySet<string>>(new Set());

  protected readonly groups = computed(() =>
    [...(this.first.value()?.data ?? []), ...this.more()].filter(
      (group) => !this.removed().has(group.id),
    ),
  );
  protected readonly next = computed(() =>
    this.moreNext() === undefined ? (this.first.value()?.page.next ?? null) : this.moreNext()!,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.first.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  private readonly languagesResource = httpResource<ApiData<{ code: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/languages`,
  );
  protected readonly languages = computed(() => {
    const codes = this.languagesResource.hasValue()
      ? this.languagesResource.value().data.map((language) => language.code)
      : [];
    return codes.length > 0 ? codes : [FALLBACK_LANGUAGE];
  });
  protected readonly required = computed(() =>
    requiredLanguage(this.languages(), this.i18n.language() ?? DEFAULT_LANGUAGE),
  );

  // The form of a new group.
  protected readonly model = linkedSignal<{ name: Record<string, string> }>(() => ({
    name: allLanguages({}, this.languages()),
  }));
  protected readonly createForm = form(this.model, (path) => {
    validateTree(path, ({ value, fieldTree }) =>
      textIssues(allLanguages(value().name, this.languages()), {}, this.required(), true).map(
        (problem) => ({ kind: problem.issue, fieldTree: fieldTree.name[problem.language] }),
      ),
    );
  });
  protected readonly failure = signal<string | null>(null);
  protected readonly submitting = computed(() => this.createForm().submitting());

  protected languageLabel(code: string): string {
    return this.i18n.t('PRODUCT_CATALOG.ATTRIBUTES.GROUP_NAME_IN', {
      language: languageName(code, this.i18n.language() ?? DEFAULT_LANGUAGE),
    });
  }

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected reload(): void {
    this.more.set([]);
    this.moreNext.set(undefined);
    this.removed.set(new Set());
    this.first.reload();
  }

  protected onRemoved(id: string): void {
    this.removed.update((ids) => new Set(ids).add(id));
  }

  protected async loadMore(): Promise<void> {
    this.loadingMore.set(true);
    this.moreFailure.set(null);
    try {
      const page = await firstValueFrom(
        this.http.get<ApiPage<AttributeGroup>>(
          this.api.baseUrl(this.groupId(), ATTRIBUTE_GROUPS_SEGMENT),
          { params: { limit: PAGE_SIZE, sort: 'name', cursor: this.next() as string } },
        ),
      );
      this.more.update((current) => [...current, ...page.data]);
      this.moreNext.set(page.page.next);
    } catch (error) {
      this.moreFailure.set(failureMessage(this.i18n, error));
    } finally {
      this.loadingMore.set(false);
    }
  }

  protected async onCreate(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.createForm, {
      action: async () => {
        this.failure.set(null);
        const body = { name: filledTexts(this.model().name) };
        try {
          await this.api.create<AttributeGroup>(
            this.groupId(),
            ATTRIBUTE_GROUPS_SEGMENT,
            body,
            this.key.forBody(body),
          );
        } catch (error) {
          return this.reject(error);
        }
        this.key.reset();
        this.toast.success(this.i18n.t('PRODUCT_CATALOG.ATTRIBUTES.CREATED'));
        this.model.set({ name: allLanguages({}, this.languages()) });
        this.createForm().reset();
        this.reload();
        return undefined;
      },
      onInvalid: () => focusFirstError(this.createForm),
    });
  }

  private reject(error: unknown): TreeValidationResult {
    if (error instanceof ApiError && error.code === 'VALIDATION_ERROR' && error.details.length > 0) {
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
      for (const { field } of error.details) {
        const found = resolveField(this.createForm, field);
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
    this.failure.set(failureMessage(this.i18n, error));
    return undefined;
  }
}
