import { Component, DestroyRef, effect, ElementRef, inject, input, signal } from '@angular/core';
import { PREVIEW_MESSAGE, PREVIEW_PORT_MESSAGE, PreviewMessage } from './preview-message';

/**
 * Preview of the HTML of an e-mail, isolated in a frame of its own document (`/email-preview.html`, served
 * with its own policy by the static server) and never inserted in the page: the frame is
 * `sandbox="allow-scripts"` and, on purpose, **never** `allow-same-origin`, so its origin is opaque (it cannot
 * reach the page, its storage or the session), with no popups, no navigation of the page above and no forms,
 * and no referrer. The HTML travels by `postMessage`; the document checks the sender and draws it.
 *
 * The frame is reached through a `MessageChannel`: at its first `load` the page hands it one port with
 * `postMessage(…, '*')`, and the HTML then travels only on our end of the channel. The `'*'` of that one
 * message is obligatory (an opaque origin cannot be named) and acceptable: it carries no data, only the
 * port, which the document accepts once and only from the application. If the frame navigates elsewhere,
 * the new document has no port, so nothing more is ever sent to it (later `load` events are ignored), and
 * the HTML, which is the template the user is editing and nothing secret, goes nowhere else. The attributes
 * of the frame are static on purpose: Angular refuses to bind the `sandbox` of a frame.
 */
@Component({
  selector: 'fc-email-preview',
  template: `<iframe
    sandbox="allow-scripts"
    src="/email-preview.html"
    referrerpolicy="no-referrer"
    [title]="label()"
    (load)="onLoad()"
  ></iframe>`,
  styles: `
    :host {
      display: block;
    }

    iframe {
      display: block;
      inline-size: 100%;
      block-size: 32rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: #fff;
    }
  `,
})
export class EmailPreview {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** Our end of the channel, once the preview document has been handed the other one. */
  protected readonly port = signal<MessagePort | null>(null);

  /** The HTML to show, as typed. */
  readonly html = input.required<string>();
  /** Accessible name of the frame (already translated). */
  readonly label = input.required<string>();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.port()?.close());
    effect(() => {
      const html = this.html();
      const port = this.port();
      if (port !== null) {
        const message: PreviewMessage = { type: PREVIEW_MESSAGE, html };
        port.postMessage(message);
      }
    });
  }

  /** The first `load` hands the document its port; a later one (the frame navigated away) is ignored. */
  protected onLoad(): void {
    if (this.port() === null) {
      const channel = new MessageChannel();
      (this.host.nativeElement.querySelector('iframe')!.contentWindow as Window).postMessage({ type: PREVIEW_PORT_MESSAGE }, '*', [channel.port2]);
      this.port.set(channel.port1);
    }
  }
}
