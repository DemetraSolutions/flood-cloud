import { Component, computed, input } from '@angular/core';

/**
 * Round avatar: the image when there is one, otherwise the initials. With `label` it is exposed
 * to assistive technology as an image with that name; without, it is decorative. The `marked`
 * flag is the "has an image" indicator of the lists, where the image itself is never loaded.
 */
@Component({
  selector: 'fc-avatar',
  templateUrl: './avatar.html',
  styleUrl: './avatar.css',
  host: {
    '[attr.role]': 'label() ? "img" : null',
    '[attr.aria-label]': 'label() || null',
    '[attr.aria-hidden]': 'label() ? null : "true"',
    '[class.marked]': 'marked()',
  },
})
export class Avatar {
  /** Data URL of the image, or `null`. */
  readonly src = input<string | null>(null);
  /** Initials shown without an image (already computed). */
  readonly initials = input('');
  /** Accessible name; leave empty when the neighbouring text already says it. */
  readonly label = input('');
  /** Marks a user that has an image that is not loaded here. */
  readonly marked = input(false);

  protected readonly hasImage = computed(() => !!this.src());
}

/**
 * Initials of a person: first letters of the first and last name, or the first two characters
 * of the username.
 */
export function initialsOf(user: {
  firstName: string | null;
  lastName: string | null;
  username: string;
}): string {
  const names = [user.firstName, user.lastName].filter((part): part is string => !!part?.trim());
  const letters =
    names.length > 0
      ? names.map((part) => part.trim().charAt(0)).join('')
      : user.username.slice(0, 2);
  return letters.slice(0, 2).toUpperCase();
}
