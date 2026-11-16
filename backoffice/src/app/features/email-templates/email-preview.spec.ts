import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EmailPreview } from './email-preview';
import { PREVIEW_MESSAGE, PREVIEW_PORT_MESSAGE } from './preview-message';

@Component({
  imports: [EmailPreview],
  template: `<fc-email-preview [html]="html()" label="Anteprima" />`,
})
class Host {
  readonly html = signal('<!DOCTYPE html><html><body><script>alert(1)</script><p>ciao</p></body></html>');
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const frame = root.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined);
  const load = async () => {
    frame.dispatchEvent(new Event('load'));
    await fixture.whenStable();
  };
  /** What the document received on its end of the channel, once handed over. */
  const received: unknown[] = [];
  const listen = () => {
    const port = (post.mock.calls[0] as unknown as [unknown, unknown, MessagePort[]])[2][0]!;
    port.onmessage = (event) => received.push(event.data);
    return port;
  };
  const delivered = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { fixture, root, frame, post, load, received, listen, delivered };
}

describe('EmailPreview', () => {
  it('shows the HTML in a sandboxed frame of its own document, with scripts allowed and nothing else', async () => {
    const { frame } = await render();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')!.split(/\s+/)).not.toContain('allow-same-origin');
    expect(frame.getAttribute('src')).toBe('/email-preview.html');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('title')).toBe('Anteprima');
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.hasAttribute('allow')).toBe(false);
  });

  it('hands the document a port once it has loaded, with no HTML in that message, and sends the HTML only on the channel', async () => {
    const { fixture, post, load, received, listen, delivered } = await render();
    expect(post).not.toHaveBeenCalled();
    await load();
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: PREVIEW_PORT_MESSAGE }, '*', [expect.anything()]);
    expect(JSON.stringify(post.mock.calls)).not.toContain('ciao');
    listen();
    const initial = fixture.componentInstance.html();
    fixture.componentInstance.html.set('<p>nuovo</p>');
    await fixture.whenStable();
    await delivered();
    expect(received).toEqual([
      { type: PREVIEW_MESSAGE, html: initial },
      { type: PREVIEW_MESSAGE, html: '<p>nuovo</p>' },
    ]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('ignores a later load of the frame (it navigated away): no new port, nothing more is sent to the frame', async () => {
    const { fixture, post, load, received, listen, delivered } = await render();
    await load();
    listen();
    await load();
    await load();
    expect(post).toHaveBeenCalledTimes(1);
    fixture.componentInstance.html.set('<p>due</p>');
    await fixture.whenStable();
    await delivered();
    expect(post).toHaveBeenCalledTimes(1);
    expect(received.at(-1)).toEqual({ type: PREVIEW_MESSAGE, html: '<p>due</p>' });
  });

  it('never inserts the HTML in the page itself, and closes the channel when destroyed', async () => {
    const { fixture, root, load, listen } = await render();
    await load();
    listen();
    const close = vi.spyOn(MessagePort.prototype, 'close');
    fixture.componentInstance.html.set('<p style="color:red">nuovo</p>');
    await fixture.whenStable();
    expect(root.querySelectorAll('iframe')).toHaveLength(1);
    expect(root.textContent).not.toContain('nuovo');
    expect(root.querySelector('p')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    fixture.destroy();
    expect(close).toHaveBeenCalled();
  });

  it('can be destroyed before the document has loaded', async () => {
    const { fixture } = await render();
    expect(() => fixture.destroy()).not.toThrow();
  });
});
