import { inject, Service } from '@angular/core';
import { DOCUMENT } from '@angular/common';

/** Reloads the current page; a seam so that components do not touch `location` directly. */
@Service()
export class PageReloader {
  private readonly document = inject(DOCUMENT);

  /** Reloads the page. */
  reload(): void {
    this.document.location.reload();
  }
}
