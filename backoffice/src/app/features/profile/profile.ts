import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import {
  email,
  FieldTree,
  form,
  FormField,
  maxLength,
  pattern,
  submit,
  TreeValidationResult,
} from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { SUPPORTED_LANGUAGES } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { Profile, Role, ScopeSummary } from '../../core/session/session.types';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ProfileApi, ProfilePatch } from './profile-api';

/** Editable fields of the profile form (text fields are `''` when empty). */
export interface ProfileModel {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  language: string;
}

const TEXT_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const;
const PHONE_PATTERN = /^[0-9 +\-()]*$/;

/** Initial form values from the profile (`null` fields become empty strings). */
export function toProfileModel(profile: Profile | null): ProfileModel {
  if (profile === null) {
    return { firstName: '', lastName: '', email: '', phone: '', language: '' };
  }
  return {
    firstName: profile.firstName ?? '',
    lastName: profile.lastName ?? '',
    email: profile.email ?? '',
    phone: profile.phone ?? '',
    language: profile.language,
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
  return patch;
}

/**
 * Profile page: read-only account data (username, role, perimeter) and a form for the personal
 * data. Only the changed fields are sent; server `422` errors land on the fields.
 */
@Component({
  selector: 'fc-profile',
  imports: [Button, FormError, FormField, RouterLink, Select, TextField, TPipe],
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
  });
  protected readonly patch = computed(() => buildProfilePatch(this.model(), this.session.me()));
  protected readonly hasChanges = computed(() => Object.keys(this.patch()).length > 0);
  protected readonly failure = signal<string | null>(null);
  protected readonly submitting = computed(() => this.profileForm().submitting());
  protected readonly languages = SUPPORTED_LANGUAGES.map((language) => ({
    value: language,
    label: this.i18n.t(`LANGUAGE.NAME.${language.toUpperCase()}`),
  }));

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

  protected error(field: FieldTree<string>): string | null {
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
      const mapped = serverFieldErrors(this.i18n, error, {
        firstName: this.profileForm.firstName,
        lastName: this.profileForm.lastName,
        email: this.profileForm.email,
        phone: this.profileForm.phone,
        language: this.profileForm.language,
      });
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
