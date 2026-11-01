import { Component, inject } from '@angular/core';
import { TPipe } from '../../../core/i18n/t-pipe';
import { ToastItem } from './toast';
import { ToastService } from './toast.service';

/** Fixed live region that renders the {@link ToastService} queue. Place it once, in the root. */
@Component({
  selector: 'fc-toast-region',
  imports: [ToastItem, TPipe],
  templateUrl: './toast-region.html',
  styleUrl: './toast-region.css',
})
export class ToastRegion {
  protected readonly service = inject(ToastService);
}
