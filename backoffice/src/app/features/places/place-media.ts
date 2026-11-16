import { Component, inject } from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { LogoSlot } from '../companies/logo-slot';
import { snake } from './place-fields';
import { LogoModel } from './place-model';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceState } from './place-state';
import { MEDIA_SLOTS, MediaSlot } from './place.types';

/**
 * Media tab of the place: the file names and URLs of the logo and the images of the place (logo
 * and cover, of the light theme and of the kiosk, and the product placeholder), chosen from the
 * media library of the group or uploaded to it.
 */
@Component({
  selector: 'fc-place-media',
  imports: [LogoSlot, PlaceFieldsView, TPipe],
  templateUrl: './place-media.html',
  styleUrl: './place-section.css',
})
export class PlaceMedia {
  protected readonly state = inject(PlaceState);

  protected readonly slots = MEDIA_SLOTS;

  protected slotError(slot: MediaSlot): string | null {
    return this.state.fieldError(this.state.form.media.logos[slot]);
  }

  protected slotKey(slot: MediaSlot): string {
    return `PLACES.MEDIA.SLOT.${snake(slot)}`;
  }

  protected setLogo(slot: MediaSlot, logo: LogoModel | null): void {
    this.state.edit('media', (media) => ({ ...media, logos: { ...media.logos, [slot]: logo } }));
  }
}
