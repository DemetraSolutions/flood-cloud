import { Component, computed, inject, input } from '@angular/core';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { Icon } from '../../shared/ui/icon/icon';
import { Release, releaseDownloadUrl } from './releases.data';

/**
 * Notes of one release: version heading, date, hotfix, download link (external site, opens in a
 * new tab) and the lists of new features, fixes and notices. Headings use `role="heading"` with
 * an explicit level so that the page and the home card can place it at their own depth.
 */
@Component({
  selector: 'fc-release-notes',
  imports: [Icon, TPipe],
  templateUrl: './release-notes.html',
  styleUrl: './release-notes.css',
})
export class ReleaseNotes {
  private readonly i18n = inject(I18nService);

  /** The release to show. */
  readonly release = input.required<Release>();
  /** Level of the version heading; the lists are one level deeper. */
  readonly level = input(2);

  protected readonly headingId = computed(() => `release-${this.release().version}`);
  protected readonly sectionLevel = computed(() => this.level() + 1);
  protected readonly downloadUrl = computed(() => releaseDownloadUrl(this.release().version));
  protected readonly date = computed(() => {
    const date = this.release().date;
    return date === null ? null : this.format(date);
  });
  protected readonly hotfix = computed(() => {
    const hotfix = this.release().hotfix;
    return hotfix === undefined
      ? null
      : this.i18n.t('RELEASES.HOTFIX', { number: hotfix.number, date: this.format(hotfix.date) });
  });

  /** Long date of an ISO day (`YYYY-MM-DD`), read as UTC so that it never shifts a day. */
  private format(day: string): string {
    return formatDate(day, this.i18n.language() ?? DEFAULT_LANGUAGE, {
      dateStyle: 'long',
      timeZone: 'UTC',
    });
  }
}
