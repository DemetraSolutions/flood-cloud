import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { TPipe } from '../../core/i18n/t-pipe';
import { Select } from '../../shared/ui/select/select';
import { withCurrent } from '../companies/company-options';
import { HoursSchedule } from './hours-schedule';
import { PlaceSave } from './place-save';
import { PlaceState } from './place-state';

/** The IANA time zones the browser knows, plus `UTC`, which the API accepts. */
const TIME_ZONES: readonly string[] = [...Intl.supportedValuesOf('timeZone'), 'UTC'];

/**
 * Opening hours tab of the place: the time zone, the opening hours of the week and the special
 * days and, for groups with the restaurant module, the hours of the delivery.
 */
@Component({
  selector: 'fc-place-hours',
  imports: [FormField, HoursSchedule, PlaceSave, Select, TPipe],
  templateUrl: './place-hours.html',
  styleUrl: './place-section.css',
})
export class PlaceHours {
  protected readonly state = inject(PlaceState);

  protected readonly f = this.state.form.openingHours;
  protected readonly timeZones = computed(() =>
    withCurrent(
      TIME_ZONES.map((zone) => ({ value: zone, label: zone })),
      this.state.model().openingHours.timezone,
      (zone) => zone,
    ),
  );
}
