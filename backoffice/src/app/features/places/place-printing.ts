import { Component, DOCUMENT, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceSave } from './place-save';
import { PlaceState } from './place-state';
import { exportPrinting, importPrinting, MAX_IMPORT_BYTES } from './printing-transfer';

/**
 * Printing tab of the place: the receipt, the pre-bill and the order layouts. Platform
 * administrators and dealers can also export the configuration to a JSON file and import it into
 * another place, as the old backoffice did.
 */
@Component({
  selector: 'fc-place-printing',
  imports: [Button, PlaceFieldsView, PlaceSave, TPipe],
  templateUrl: './place-printing.html',
  styleUrl: './place-section.css',
})
export class PlacePrinting {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly document = inject(DOCUMENT);

  /** Downloads the configuration of the tab as a JSON file. */
  protected export(): void {
    const url = URL.createObjectURL(
      new Blob([exportPrinting(this.state.model().printing.f)], { type: 'application/json' }),
    );
    const link = this.document.createElement('a');
    link.href = url;
    link.download = 'printing.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Reads the chosen file and puts its values in the tab (nothing is saved until the user saves). */
  protected async import(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = (input.files as FileList)[0];
    input.value = '';
    if (file.size > MAX_IMPORT_BYTES) {
      this.toast.error(this.i18n.t('PLACES.PRINTING.IMPORT_TOO_LARGE'));
      return;
    }
    const result = importPrinting(await file.text());
    if (result === null) {
      this.toast.error(this.i18n.t('PLACES.PRINTING.IMPORT_INVALID'));
      return;
    }
    this.state.edit('printing', (block) => ({ ...block, f: { ...block.f, ...result.values } }));
    this.toast.success(
      this.i18n.t('PLACES.PRINTING.IMPORTED', { applied: result.applied, ignored: result.ignored }),
    );
  }
}
