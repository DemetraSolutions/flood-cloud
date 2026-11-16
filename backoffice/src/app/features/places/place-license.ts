import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { PlaceSave } from './place-save';
import { PlaceState } from './place-state';

/**
 * License tab of the place: the plan (platform administrators), the expiration date and the
 * status (platform administrators and dealers) and the Sentry switch of the POS (platform
 * administrators). The fields a user may not change are shown read-only.
 */
@Component({
  selector: 'fc-place-license',
  imports: [Checkbox, FormField, PlaceSave, Select, TextField, TPipe],
  templateUrl: './place-license.html',
  styleUrl: './place-section.css',
})
export class PlaceLicense {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly f = this.state.form.license;

  protected readonly planOptions = this.state.planOptions;
  protected readonly statusOptions = computed(() => [
    { value: 'active', label: this.i18n.t('PLACES.STATUS.ACTIVE') },
    { value: 'disabled', label: this.i18n.t('PLACES.STATUS.DISABLED') },
  ]);
}
