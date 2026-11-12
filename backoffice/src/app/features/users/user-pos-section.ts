import { Component, computed, inject } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select } from '../../shared/ui/select/select';
import { PosGrantsFields } from './pos-grants-fields';
import { PosOptionsFields } from './pos-options-fields';
import { PosPriceLists } from './pos-price-lists';
import { UserFormState } from './user-form-state';
import { PosOptionsModel } from './user-model';

/**
 * Point-of-sale data of the user: whether the POS is enabled, its permissions, the interface
 * preferences and the price lists the user can use. Shown only when the group has the cash
 * feature and the user is an SA, CA or PA. When creating, only a note is shown: the server
 * applies the defaults of the role and the data are changed afterwards on the record.
 */
@Component({
  selector: 'fc-user-pos-section',
  imports: [
    Button,
    Checkbox,
    FormField,
    PosGrantsFields,
    PosOptionsFields,
    PosPriceLists,
    Select,
    TPipe,
  ],
  templateUrl: './user-pos-section.html',
  styleUrl: './user-section.css',
})
export class UserPosSection {
  protected readonly state = inject(UserFormState);
  protected readonly pos = this.state.userForm.pos;
  protected readonly options = this.pos.options as FieldTree<PosOptionsModel>;

  protected readonly showDetails = computed(() => !this.state.isNew());
  protected readonly priceListChoices = computed(() =>
    this.state.priceLists().map((list) => ({ id: list.id, name: list.name })),
  );
  protected readonly priceListOptions = computed(() =>
    this.state.priceLists().map((list) => ({ value: list.id, label: list.name })),
  );
}
