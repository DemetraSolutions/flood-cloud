import {
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { TrashApi } from './trash-api';
import { GroupTrashKind, TrashEmptyResponse, TrashItemResult } from './trash.types';

/** Progress of the emptying: items deleted so far and items still in the trash (`null` before the first answer). */
interface Progress {
  readonly deleted: number;
  readonly remaining: number | null;
}

/**
 * "Svuota cestino" of one tab (platform administrators only). It asks for an explicit
 * confirmation (a checkbox that must be ticked), then calls `empty` again and again, passing the
 * `next` cursor of each answer, until the server reports none. The user can stop between two calls (also by
 * closing the dialog). When it ends, `finished` carries the results of every call (also after a
 * stop or a failure, which is reported in a toast).
 */
@Component({
  selector: 'fc-trash-empty-dialog',
  imports: [Button, Checkbox, Dialog, TPipe],
  templateUrl: './trash-empty-dialog.html',
})
export class TrashEmptyDialog {
  private readonly api = inject(TrashApi);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  /** Group whose trash is emptied. */
  readonly groupId = input.required<string>();
  /** Kind of the items. */
  readonly kind = input.required<GroupTrashKind>();
  /** Items known to be in the trash, or `null` when the tab shows only part of them. */
  readonly count = input<number | null>(null);
  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** Emitted when the emptying ended, with the results of all the calls. */
  readonly finished = output<readonly TrashItemResult[]>();

  protected readonly understood = signal(false);
  protected readonly running = signal(false);
  protected readonly stopping = signal(false);
  protected readonly progress = signal<Progress>({ deleted: 0, remaining: null });

  protected readonly kindLabel = computed(() =>
    this.i18n.t(`TRASH.KIND.${this.kind().toUpperCase()}`),
  );
  protected readonly message = computed(() => {
    const count = this.count();
    return count === null
      ? this.i18n.t('TRASH.EMPTY.MESSAGE_ALL', { kind: this.kindLabel() })
      : this.i18n.t('TRASH.EMPTY.MESSAGE_COUNT', { count, kind: this.kindLabel() });
  });
  protected readonly progressText = computed(() => {
    const { deleted, remaining } = this.progress();
    return remaining === null
      ? this.i18n.t('TRASH.EMPTY.STARTING')
      : this.i18n.t('TRASH.EMPTY.PROGRESS', { deleted, remaining });
  });

  constructor() {
    // Every opening starts from the confirmation.
    effect(() => {
      if (this.open()) {
        untracked(() => {
          this.understood.set(false);
          this.stopping.set(false);
          this.progress.set({ deleted: 0, remaining: null });
        });
      }
    });
  }

  /** The user asked to stop: the call in flight ends, the next is not made. */
  protected stop(): void {
    this.stopping.set(true);
  }

  /** Closing while running is a request to stop. */
  protected onClosed(): void {
    if (this.running()) {
      this.stopping.set(true);
    }
  }

  protected async start(): Promise<void> {
    const results: TrashItemResult[] = [];
    this.running.set(true);
    try {
      let after: string | null = null;
      do {
        const response: TrashEmptyResponse = await this.api.empty(
          this.groupId(),
          this.kind(),
          after ?? undefined,
        );
        results.push(...response.results);
        const deleted = response.results.filter((result) => result.outcome === 'deleted').length;
        after = response.next;
        this.progress.update((current) => ({
          deleted: current.deleted + deleted,
          remaining: response.remaining,
        }));
      } while (after !== null && !this.stopping());
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
    } finally {
      this.running.set(false);
    }
    this.open.set(false);
    this.finished.emit(results);
  }
}
