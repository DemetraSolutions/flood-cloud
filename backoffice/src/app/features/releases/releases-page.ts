import { Component } from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReleaseNotes } from './release-notes';
import { RELEASES } from './releases.data';

/** Release notes of the point-of-sale app, newest first, for platform administrators and dealers (`/releases`). */
@Component({
  selector: 'fc-releases-page',
  imports: [ReleaseNotes, TPipe],
  templateUrl: './releases-page.html',
  styleUrl: './releases-page.css',
})
export class ReleasesPage {
  protected readonly releases = RELEASES;
}
