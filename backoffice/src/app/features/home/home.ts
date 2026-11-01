import { Component } from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';

/** Placeholder home page; replaced by the real dashboard in later steps. */
@Component({
  selector: 'fc-home',
  imports: [TPipe],
  templateUrl: './home.html',
})
export class Home {}
