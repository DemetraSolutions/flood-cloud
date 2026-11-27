import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  disabled,
  form,
  FormField,
  maxLength,
  ReadonlyFieldTree,
  required,
  submit,
  validate,
} from '@angular/forms/signals';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { MAX_LOOKUP_IDS, ReferenceApi } from '../../../core/reference/reference-api';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { Icon } from '../../../shared/ui/icon/icon';
import { uniqueId } from '../../../shared/ui/unique-id';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { ReferenceLoader, ReferencePicker } from '../../users/reference-picker';
import { selectionNames } from '../catalogs/reference-loaders';
import {
  ApiKey,
  ApiKeyCreateBody,
  ApiKeyPatch,
  permissionTextKey,
  PUBLIC_PERMISSIONS,
  PublicApiSettings,
} from './api-key.types';
import { keyEditorErrors } from './api-key-errors';
import {
  buildCreateBody,
  buildPatch,
  expiryIssue,
  KeyModel,
  limitIssue,
  tooManyIds,
  toKeyModel,
} from './api-key-model';

const FIELDS = [
  'name',
  'permissions',
  'restrictions.companyIds',
  'restrictions.placeIds',
  'expiresAt',
  'rateLimitPerMinute',
  'dailyQuota',
] as const;

/**
 * Form of a public API key, in a dialog: name, permissions of the public catalog (at least one),
 * optional restrictions to companies and stores of the group, optional expiry day and, for the
 * platform administrator only, the limits. A dealer sees the limits (the inherited ones when
 * creating, the key's own when modifying) read-only, and they are never sent. Emits the body of
 * the creation, or the patch with only what changed.
 */
@Component({
  selector: 'fc-api-key-editor',
  imports: [Button, Checkbox, FormError, FormField, Icon, ReferencePicker, TextField, TPipe],
  templateUrl: './api-key-editor.html',
  styleUrl: './api-key-editor.css',
})
export class ApiKeyEditor {
  private readonly reference = inject(ReferenceApi);
  protected readonly i18n = inject(I18nService);

  /** Group the key belongs to. */
  readonly groupId = input.required<string>();
  /** The key being changed; `null` to create one. */
  readonly item = input<ApiKey | null>(null);
  /** Limits a new key inherits from the group. */
  readonly inherited = input.required<PublicApiSettings>();
  /** Whether the user may set the limits (the platform administrator). */
  readonly canSetLimits = input(false);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body of the creation or the patch of the modification. */
  readonly save = output<ApiKeyCreateBody | ApiKeyPatch>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly permissions = PUBLIC_PERMISSIONS;
  protected readonly permissionsErrorId = uniqueId('fc-api-key-permissions-error');
  protected readonly label = (permission: (typeof PUBLIC_PERMISSIONS)[number]): string =>
    this.i18n.t(permissionTextKey(permission, 'LABEL'));
  protected readonly hint = (permission: (typeof PUBLIC_PERMISSIONS)[number]): string =>
    this.i18n.t(permissionTextKey(permission, 'HINT'));

  protected readonly model = linkedSignal<KeyModel>(() =>
    toKeyModel(this.item(), this.inherited()),
  );
  private readonly stored = computed(() => {
    const item = this.item();
    return item === null ? null : toKeyModel(item, this.inherited());
  });
  protected readonly keyForm = form(this.model, (path) => {
    required(path.name);
    maxLength(path.name, 100);
    validate(path.permissions, ({ value }) =>
      PUBLIC_PERMISSIONS.some((permission) => value()[permission])
        ? undefined
        : { kind: 'required' },
    );
    validate(path.companyIds, ({ value }) =>
      tooManyIds(value()) ? { kind: 'tooMany' } : undefined,
    );
    validate(path.placeIds, ({ value }) => (tooManyIds(value()) ? { kind: 'tooMany' } : undefined));
    validate(path.expiresOn, ({ value }) => {
      // An expiry kept as it was is not checked again: it may be close to its end.
      const kind =
        value() === (this.stored()?.expiresOn ?? '') && this.item() !== null
          ? undefined
          : expiryIssue(value(), new Date());
      return kind === undefined ? undefined : { kind };
    });
    disabled(path.rateLimitPerMinute, () => !this.canSetLimits());
    disabled(path.dailyQuota, () => !this.canSetLimits());
    validate(path.rateLimitPerMinute, ({ value }) => {
      const kind = limitIssue(value(), 'minute');
      return kind === undefined ? undefined : { kind };
    });
    validate(path.dailyQuota, ({ value }) => {
      const kind = limitIssue(value(), 'day');
      return kind === undefined ? undefined : { kind };
    });
  });

  protected readonly companyLoader = computed<ReferenceLoader>(
    () => (query) => this.reference.companies(this.groupId(), query),
  );
  protected readonly placeLoader = computed<ReferenceLoader>(
    () => (query) => this.reference.places(this.groupId(), query),
  );
  protected readonly companyNames = selectionNames(
    () => this.item()?.restrictions.companyIds ?? [],
    (ids) => this.names('companies', ids),
  );
  protected readonly placeNames = selectionNames(
    () => this.item()?.restrictions.placeIds ?? [],
    (ids) => this.names('places', ids),
  );

  protected readonly errors = computed(() =>
    keyEditorErrors(this.i18n, this.error(), FIELDS, this.item() === null),
  );
  protected readonly body = computed<ApiKeyCreateBody | ApiKeyPatch>(() => {
    const item = this.item();
    return item === null
      ? buildCreateBody(this.model(), this.inherited(), this.canSetLimits())
      : buildPatch(this.model(), item, this.canSetLimits());
  });
  protected readonly hasChanges = computed(
    () => this.item() === null || Object.keys(this.body()).length > 0,
  );
  /** A key allowed to write the catalog and limited to no company or place may change all of it. */
  protected readonly unrestrictedWrite = computed(() => {
    const model = this.model();
    return (
      model.permissions['catalog:write'] &&
      model.companyIds.length === 0 &&
      model.placeIds.length === 0
    );
  });
  /** A key allowed to read the sales: they carry the amounts and the customer of every sale, never personal data of the customer. */
  protected readonly readsSales = computed(() => this.model().permissions['sales:read']);
  protected readonly permissionsError = computed(
    () =>
      fieldErrorMessage(this.i18n, this.keyForm.permissions()) ??
      this.errors().fields['permissions'] ??
      null,
  );

  protected message(
    field: ReadonlyFieldTree<unknown>,
    name: (typeof FIELDS)[number],
  ): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.keyForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.keyForm),
    });
  }

  private async names(
    kind: 'companies' | 'places',
    ids: readonly string[],
  ): Promise<Record<string, string>> {
    const page = await this.reference[kind](this.groupId(), { ids, limit: MAX_LOOKUP_IDS });
    return Object.fromEntries(page.data.map((entry) => [entry.id, entry.name]));
  }
}
