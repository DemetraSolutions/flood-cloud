/** Address of the preview document (`public/email-preview.html`), served with its own Content-Security-Policy. */
export const PREVIEW_URL = '/email-preview.html';

/** `type` of the message that carries the HTML to the preview document. */
export const PREVIEW_MESSAGE = 'fc-email-preview';

/** The message the template page posts to the preview frame. */
export interface PreviewMessage {
  readonly type: typeof PREVIEW_MESSAGE;
  readonly html: string;
}

/** `type` of the one message that hands the preview frame its end of the channel, over which the HTML then travels. */
export const PREVIEW_PORT_MESSAGE = 'fc-email-preview-port';
