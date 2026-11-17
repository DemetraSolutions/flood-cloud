import { Component, computed, inject } from '@angular/core';
import { GroupSettingsState } from '../group-settings-state';
import { PLATFORM_DEFAULTS } from './api-key.types';
import { ApiKeysList } from './api-keys-list';
import { PublicApiSettingsBlock } from './public-api-settings';

/**
 * "API pubbliche" section of the group record (platform administrators and dealers, permission
 * `apiKeys:read`): the settings of the public API of the group and the list of its keys. The
 * server decides on every call; the tab is hidden and the route closed to everyone else.
 */
@Component({
  selector: 'fc-group-public-api',
  imports: [ApiKeysList, PublicApiSettingsBlock],
  templateUrl: './group-public-api.html',
  styleUrl: './group-public-api.css',
})
export class GroupPublicApi {
  protected readonly state = inject(GroupSettingsState);

  /** The limits a new key inherits: the group's own, or the platform's. */
  protected readonly inherited = computed(() => this.state.group()?.publicApi ?? PLATFORM_DEFAULTS);
}
