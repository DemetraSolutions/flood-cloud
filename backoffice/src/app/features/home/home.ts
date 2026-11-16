import { Component, computed, inject } from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { LatestRelease } from '../releases/latest-release';

/** Home page; platform administrators and dealers also see the latest release. */
@Component({
  selector: 'fc-home',
  imports: [LatestRelease, TPipe],
  templateUrl: './home.html',
})
export class Home {
  private readonly session = inject(SessionService);

  protected readonly showRelease = computed(() => {
    const role = this.session.me()?.role;
    return role === 'PSA' || role === 'D';
  });
}
