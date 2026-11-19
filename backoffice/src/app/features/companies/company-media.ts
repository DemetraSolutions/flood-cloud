import { Component, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { TPipe } from '../../core/i18n/t-pipe';
import { TextField } from '../../shared/ui/text-field/text-field';
import { LogoModel } from './company-model';
import { CompanyState } from './company-state';
import { LogoSlot } from './logo-slot';

/**
 * Media tab: the file name and external URL of the company and the two logos of the customer
 * app (light and dark), chosen from the media library of the group or uploaded to it.
 */
@Component({
  selector: 'fc-company-media',
  imports: [FormField, LogoSlot, TextField, TPipe],
  templateUrl: './company-media.html',
  styleUrl: './company-section.css',
})
export class CompanyMedia {
  protected readonly state = inject(CompanyState);

  protected readonly f = this.state.form.media;

  protected setLogo(
    slot: 'customersAppLogoLight' | 'customersAppLogoDark',
    logo: LogoModel | null,
  ): void {
    this.state.edit('media', (media) => ({ ...media, [slot]: logo }));
  }
}
