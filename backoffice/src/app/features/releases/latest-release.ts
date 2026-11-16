import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReleaseNotes } from './release-notes';
import { RELEASES } from './releases.data';

/** Home card with the latest release (the first item of the release data) and a link to all of them. */
@Component({
  selector: 'fc-latest-release',
  imports: [ReleaseNotes, RouterLink, TPipe],
  templateUrl: './latest-release.html',
  styleUrl: './latest-release.css',
})
export class LatestRelease {
  protected readonly release = RELEASES[0];
}
