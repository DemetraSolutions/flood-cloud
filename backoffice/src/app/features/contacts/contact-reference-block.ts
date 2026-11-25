import { Component, inject, input, output } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ReferenceKind } from './contact-errors';

/** Most references the server lists in all. */
const MAX_LISTED = 20;

/**
 * The panel that says what still refers to a contact or a group of contacts the server refused to
 * delete, kind by kind (the text of a kind is `CONTACTS.REFERENCE.<kind>`) with how many
 * references the server listed. It never shows who they are: they may be contacts or documents
 * the user cannot read.
 */
@Component({
  selector: 'fc-contact-reference-block',
  imports: [Button, TPipe],
  templateUrl: './contact-reference-block.html',
  styleUrl: './contact-reference-block.css',
})
export class ContactReferenceBlock {
  protected readonly i18n = inject(I18nService);

  /** Title of the panel (already translated). */
  readonly heading = input.required<string>();
  /** The explanation (already translated). */
  readonly message = input.required<string>();
  /** What refers to the entry. */
  readonly kinds = input.required<readonly ReferenceKind[]>();
  /** The user dismissed the panel. */
  readonly closed = output<void>();

  /** How many references of a kind: the server lists at most 20 in all, so 20 means "20 or more". */
  protected countText(count: number): string {
    return count >= MAX_LISTED ? this.i18n.t('CONTACTS.REFERENCE.MANY', { count }) : String(count);
  }

  protected kindLabel(kind: string): string {
    return this.i18n.t(`CONTACTS.REFERENCE.${kind}`);
  }
}
