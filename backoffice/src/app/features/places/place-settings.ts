import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TPipe } from '../../core/i18n/t-pipe';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { SETTINGS_MENU_GROUPS } from './place-nav';
import { PlaceState } from './place-state';

/**
 * Settings tab of the place: the side menu of the old backoffice (four groups: settings,
 * functionality, prints, other) and the entry the child route shows next to it. The entries the
 * user does not see (by role and by the features of the group) are not in the menu; each entry
 * is marked with its unsaved changes and its errors.
 */
@Component({
  selector: 'fc-place-settings',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, StatusBadge, TPipe],
  templateUrl: './place-settings.html',
  styleUrl: './place-settings.css',
})
export class PlaceSettings {
  protected readonly state = inject(PlaceState);

  /** The groups of the menu that have entries the user sees. */
  protected readonly groups = computed(() =>
    SETTINGS_MENU_GROUPS.map((id) => ({
      id,
      entries: this.state.entries().filter((entry) => entry.group === id),
    })).filter((group) => group.entries.length > 0),
  );
}
