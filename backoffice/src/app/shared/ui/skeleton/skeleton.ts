import { Component, computed, input } from '@angular/core';
import { TPipe } from '../../../core/i18n/t-pipe';

/** Loading placeholder: `aria-busy` region with a visually hidden status text. */
@Component({
  selector: 'fc-skeleton',
  imports: [TPipe],
  templateUrl: './skeleton.html',
  styleUrl: './skeleton.css',
  host: { role: 'status', 'aria-busy': 'true' },
})
export class Skeleton {
  /** Number of placeholder lines. */
  readonly lines = input(3);

  protected readonly rows = computed(() => Array.from({ length: this.lines() }, (_, i) => i));
}
