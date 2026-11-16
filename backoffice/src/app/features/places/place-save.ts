import { Component, inject, input } from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { PlaceState } from './place-state';
import { PlaceSection } from './place.types';

/**
 * The save button of a tab: it saves that tab on its own (the creation, on the page of a new
 * place). Hidden for whoever cannot write; disabled until the tab has changes.
 */
@Component({
  selector: 'fc-place-save',
  imports: [Button, TPipe],
  template: `
    @if (state.canWrite()) {
      <div class="actions">
        <button
          fc-button
          [loading]="state.saving()"
          [disabled]="!state.isNew() && !state.dirty().has(section())"
          (click)="state.save(section())"
        >
          {{ (state.isNew() ? 'PLACES.CREATE' : 'COMMON.SAVE') | t }}
        </button>
      </div>
    }
  `,
  styles: `
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3);
    }
  `,
})
export class PlaceSave {
  protected readonly state = inject(PlaceState);

  /** The section this button saves. */
  readonly section = input.required<PlaceSection>();
}
