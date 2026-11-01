import { inject, Service } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { I18nService } from '../i18n/i18n.service';
import { PageAnnouncer } from './page-announcer';

/**
 * Page titles from the dictionary: a route's `title` is a dictionary key. The document title
 * becomes "Page · Flood Cloud" and the page title is announced through {@link PageAnnouncer}.
 */
@Service()
export class PageTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly i18n = inject(I18nService);
  private readonly announcer = inject(PageAnnouncer);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const key = this.buildTitle(snapshot);
    const appName = this.i18n.t('APP.NAME');
    const pageTitle = key === undefined ? appName : this.i18n.t(key);
    this.title.setTitle(key === undefined ? appName : `${pageTitle} · ${appName}`);
    this.announcer.announce(pageTitle);
  }
}
