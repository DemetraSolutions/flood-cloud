import { PageHeader } from '../../shared/ui/page-header/page-header';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import {
  email,
  FieldTree,
  form,
  FormField,
  maxLength,
  pattern,
  ReadonlyFieldTree,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { SUPPORTED_LANGUAGES } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { THEME_CHOICES } from '../../core/theme/theme.service';
import { SessionService } from '../../core/session/session.service';
import { Profile, Role, ScopeSummary } from '../../core/session/session.types';
import { AvatarField } from '../../shared/ui/avatar-field/avatar-field';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { initialsOf } from '../../shared/ui/avatar/avatar';
import { Button } from '../../shared/ui/button/button';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PosOptionsFields, FavoritesChoice } from '../users/pos-options-fields';
import { percentIssue } from '../users/percent';
import { blankPos, PosOptionsModel, posModelOf } from '../users/user-model';
import { optionsPatch } from '../users/user-payload';
import { fieldAt, normalizeField } from '../users/users-errors';
import { OwnPin } from './own-pin';
import { ProfileApi, ProfilePatch } from './profile-api';

/** Editable fields of the profile form (text fields are `''` when empty). */
export interface ProfileModel {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  language: string;
  theme: string;
  /** Data URL of the avatar, `''` for none. */
  avatar: string;
  /** The user's own point-of-sale preferences. */
  pos: { options: PosOptionsModel };
}

const TEXT_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const;
const PHONE_PATTERN = /^[0-9 +\-()]*$/;

/**
 * Whether the profile has point-of-sale preferences to edit: the POS is enabled for the user and
 * the group has the cash feature.
 */
export function hasPosPreferences(profile: Profile | null): boolean {
  return profile !== null && profile.pos.enabled && profile.groupFeatures?.cash === true;
}

/** Initial form values from the profile (`null` fields become empty strings). */
export function toProfileModel(profile: Profile | null): ProfileModel {
  if (profile === null) {
    return {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      language: '',
      theme: '',
      avatar: '',
      pos: { options: blankPos().options },
    };
  }
  return {
    firstName: profile.firstName ?? '',
    lastName: profile.lastName ?? '',
    email: profile.email ?? '',
    phone: profile.phone ?? '',
    language: profile.language,
    theme: profile.theme,
    avatar: profile.avatar ?? '',
    pos: { options: posModelOf(profile.pos).options },
  };
}

/**
 * Builds the `PATCH` body with only the fields that differ from the stored profile; an emptied
 * text field becomes `null` (clears it).
 */
export function buildProfilePatch(model: ProfileModel, profile: Profile | null): ProfilePatch {
  const patch: ProfilePatch = {};
  if (profile === null) {
    return patch;
  }
  for (const field of TEXT_FIELDS) {
    const next = model[field].trim() === '' ? null : model[field].trim();
    if (next !== profile[field]) {
      patch[field] = next;
    }
  }
  if (model.language !== profile.language) {
    patch.language = model.language;
  }
  if (model.theme !== profile.theme) {
    patch.theme = model.theme;
  }
  if (model.avatar !== (profile.avatar ?? '')) {
    patch.avatar = model.avatar === '' ? null : model.avatar;
  }
  if (hasPosPreferences(profile)) {
    const options = optionsPatch(model.pos.options, posModelOf(profile.pos).options, true);
    if (options !== null) {
      patch.pos = { options };
    }
  }
  return patch;
}

/**
 * Profile page: read-only account data (username, role, perimeter) and a form for the personal
 * data. Only the changed fields are sent; server `422` errors land on the fields.
 */
@Component({
  selector: 'fc-profile',
  imports: [
    PageHeader,
    AvatarField,
    Button,
    FormError,
    FormField,
    OwnPin,
    PosOptionsFields,
    RouterLink,
    Select,
    TextField,
    TPipe,
  ],
  templateUrl: './profile.html',
  styleUrl: './profile.css',
})
export class ProfilePage {
  protected readonly session = inject(SessionService);
  private readonly api = inject(ProfileApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  protected readonly model = linkedSignal(() => toProfileModel(this.session.me()));
  protected readonly profileForm = form(this.model, (path) => {
    maxLength(path.firstName, 100);
    maxLength(path.lastName, 100);
    maxLength(path.email, 254);
    email(path.email);
    maxLength(path.phone, 32);
    pattern(path.phone, PHONE_PATTERN);
    validate(path.pos.options.quickDiscount, ({ value }) => percentIssue(value()));
  });
  protected readonly patch = computed(() => buildProfilePatch(this.model(), this.session.me()));
  protected readonly hasChanges = computed(() => Object.keys(this.patch()).length > 0);
  protected readonly failure = signal<string | null>(null);
  protected readonly submitting = computed(() => this.profileForm().submitting());
  protected readonly languages = SUPPORTED_LANGUAGES.map((language) => ({
    value: language,
    label: this.i18n.t(`LANGUAGE.NAME.${language.toUpperCase()}`),
  }));

  protected readonly themes = THEME_CHOICES.map((choice) => ({
    value: choice,
    label: this.i18n.t(`THEME.${choice.toUpperCase()}`),
  }));

  protected readonly showPos = computed(() => hasPosPreferences(this.session.me()));
  protected readonly initials = computed(() => {
    const me = this.session.me();
    return me === null ? '' : initialsOf(me);
  });
  protected readonly options = this.profileForm.pos.options as FieldTree<PosOptionsModel>;
  private readonly favoritesResource = httpResource<ApiData<FavoritesChoice[]>>(() => {
    const groupId = this.session.me()?.groupId;
    return this.showPos() && this.session.can('products:read') && groupId
      ? `/v1/groups/${encodeURIComponent(groupId)}/product-favorites`
      : undefined;
  });
  /** Favorites lists of the group; `null` when the user cannot read them (or they are not read yet). */
  protected readonly favorites = computed<readonly FavoritesChoice[] | null>(() =>
    this.favoritesResource.hasValue() ? this.favoritesResource.value().data : null,
  );

  /** Display name of a role. */
  protected roleLabel(role: Role): string {
    return this.i18n.t(`ROLE.${role}`);
  }

  /** Text describing the data perimeter of the user. */
  protected scopeText(scope: ScopeSummary): string {
    switch (scope.kind) {
      case 'platform':
        return this.i18n.t('PROFILE.SCOPE.PLATFORM');
      case 'dealer':
        return this.i18n.t('PROFILE.SCOPE.DEALER', { groups: scope.groups });
      case 'group':
        return this.i18n.t('PROFILE.SCOPE.GROUP');
      case 'companies':
        return this.i18n.t('PROFILE.SCOPE.COMPANIES', {
          companies: scope.companies,
          places: scope.places,
        });
      case 'places':
        return this.i18n.t('PROFILE.SCOPE.PLACES', { places: scope.places });
      case 'none':
        return this.i18n.t('PROFILE.SCOPE.NONE');
    }
  }

  protected error(field: FieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.profileForm, {
      action: async () => {
        this.failure.set(null);
        try {
          this.session.setProfile(await this.api.update(this.patch()));
        } catch (error) {
          return this.reject(error);
        }
        this.profileForm().reset();
        this.toast.success(this.i18n.t('PROFILE.SAVED'));
        return undefined;
      },
      onInvalid: () => focusFirstError(this.profileForm),
    });
  }

  private reject(error: unknown): TreeValidationResult {
    if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
      for (const { field } of error.details) {
        const tree = fieldAt(this.profileForm, normalizeField(field));
        if (tree !== undefined) {
          fields[field] = tree;
        }
      }
      const mapped = serverFieldErrors(this.i18n, error, fields);
      if (mapped.unmatched) {
        this.show(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
      }
      return mapped.errors;
    }
    this.show(failureMessage(this.i18n, error));
    return undefined;
  }

  private show(message: string): void {
    this.failure.set(message);
  }
}
