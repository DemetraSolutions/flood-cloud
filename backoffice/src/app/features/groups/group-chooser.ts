import { Component } from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';

/** Landing of the group area for a PSA or dealer who has not chosen a working group yet. */
@Component({
  selector: 'fc-group-chooser',
  imports: [TPipe],
  template: `<h1>{{ 'GROUP_CHOOSER.TITLE' | t }}</h1>
    <p>{{ 'GROUP_CHOOSER.MESSAGE' | t }}</p>`,
})
export class GroupChooser {}
