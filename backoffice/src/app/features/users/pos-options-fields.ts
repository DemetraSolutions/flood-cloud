import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import {
  POS_CHOICE_NAMES,
  POS_CHOICES,
  POS_OPTION_GROUPS,
  PosChoice,
  posKey,
} from '../../core/users/pos.catalog';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { PosOptionsModel } from './user-model';

/** A favorites list the preference `favoritesId` can point to. */
export interface FavoritesChoice {
  readonly id: string;
  readonly name: string;
}

/**
 * Interface preferences of the point of sale (`pos.options` without the price lists): grouped
 * checkboxes, the choice preferences and the favorites list. They are preferences, not
 * permissions: whoever can edit the user (or the user, from the profile) changes them. It is
 * used by the user form and by the profile, so it takes the field tree and nothing else.
 */
@Component({
  selector: 'fc-pos-options-fields',
  imports: [Checkbox, FormField, Select, TextField, TPipe],
  templateUrl: './pos-options-fields.html',
  styleUrl: './user-section.css',
})
export class PosOptionsFields {
  private readonly i18n = inject(I18nService);

  /** The preferences field tree. */
  readonly options = input.required<FieldTree<PosOptionsModel>>();
  /** Favorites lists of the group; `null` when the user cannot read them. */
  readonly favorites = input<readonly FavoritesChoice[] | null>(null);

  protected readonly groups = POS_OPTION_GROUPS;
  protected readonly choices = POS_CHOICE_NAMES;

  protected readonly favoriteOptions = computed(() =>
    (this.favorites() ?? []).map((list) => ({ value: list.id, label: list.name })),
  );

  protected optionLabel(name: string): string {
    return this.i18n.t(`USERS.POS.OPTION.${posKey(name)}`);
  }

  protected groupLabel(id: string): string {
    return this.i18n.t(`USERS.POS.OPTION_GROUP.${id}`);
  }

  protected choiceLabel(name: PosChoice): string {
    return this.i18n.t(`USERS.POS.CHOICE.${posKey(name)}`);
  }

  protected choiceOptions(name: PosChoice): { value: string; label: string }[] {
    return POS_CHOICES[name].map((value) => ({ value, label: this.valueLabel(name, value) }));
  }

  private valueLabel(name: PosChoice, value: string): string {
    if (value === '') {
      return this.i18n.t('USERS.POS.CHOICE_NONE');
    }
    if (name === 'roomsGridZoomHandheld') {
      return `${value}x`;
    }
    if (name === 'roomsTablesColumns' || name === 'roomsTablesColumnsHandheld') {
      return value;
    }
    return this.i18n.t(
      `USERS.POS.CHOICE_VALUE.${posKey(name)}.${value.toUpperCase().replace(/-/g, '_')}`,
    );
  }

  protected error(field: FieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }
}
