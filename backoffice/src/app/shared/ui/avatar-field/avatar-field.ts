import {
  booleanAttribute,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { AVATAR_TYPES, AvatarEncoder, AvatarError } from '../../util/avatar-encoder';
import { Avatar } from '../avatar/avatar';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';
import { uniqueId } from '../unique-id';

/**
 * Chooser of an avatar: preview, "choose" and "remove" buttons. The picked file is scaled and
 * encoded in the browser ({@link AvatarEncoder}) so it fits the 200 KB of the backend. The
 * `value` model is the data URL (`''` for none), as Signal Forms expects of a value control.
 */
@Component({
  selector: 'fc-avatar-field',
  imports: [Avatar, Button, Icon, TPipe],
  templateUrl: './avatar-field.html',
  styleUrls: ['../field.css', './avatar-field.css'],
})
export class AvatarField {
  private readonly encoder = inject(AvatarEncoder);
  private readonly i18n = inject(I18nService);
  private readonly picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');

  /** Legend of the group (already translated). */
  readonly label = input.required<string>();
  /** Data URL of the image, `''` for none (two-way). */
  readonly value = model('');
  /** Initials shown while there is no image. */
  readonly initials = input('');
  /** Message of a server error on the field. */
  readonly error = input<string | null>(null);
  /** Whether the user has an image that cannot be shown (legacy data). */
  readonly hiddenImage = input(false, { transform: booleanAttribute });
  /** Disables the buttons. */
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-avatar-field');
  protected readonly errorId = `${this.id}-error`;
  protected readonly accept = AVATAR_TYPES.join(',');
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly message = computed(() => this.problem() ?? this.error());

  /** Focuses the choose button (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.picker().nativeElement.parentElement?.querySelector('button')?.focus();
  }

  protected open(): void {
    this.picker().nativeElement.click();
  }

  protected remove(): void {
    this.problem.set(null);
    this.value.set('');
  }

  protected async onPick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.item(0) ?? null;
    input.value = '';
    if (file === null) {
      return;
    }
    this.problem.set(null);
    this.busy.set(true);
    try {
      this.value.set(await this.encoder.encode(file));
    } catch (error) {
      if (error instanceof AvatarError) {
        this.problem.set(this.i18n.t(`AVATAR.PROBLEM.${error.problem.toUpperCase()}`));
      } else {
        console.error(error);
        this.problem.set(this.i18n.t('ERRORS.GENERIC.MESSAGE'));
      }
    } finally {
      this.busy.set(false);
    }
  }
}
