import { readFileSync } from 'node:fs';
import { PREVIEW_MESSAGE, PREVIEW_PORT_MESSAGE } from './preview-message';

const SCRIPT = readFileSync(`${process.cwd()}/public/email-preview.js`, 'utf8');
const PAGE = readFileSync(`${process.cwd()}/public/email-preview.html`, 'utf8');

type Listener = (event: unknown) => void;
interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Runs the script as the browser would, keeping the listeners it registers (so each test has an instance of its own). */
function start(): { message: Listener; click: Listener } {
  const listeners: Record<string, Listener> = {};
  const record = (type: string, listener: unknown) => {
    listeners[type] = listener as Listener;
  };
  const onWindow = vi.spyOn(window, 'addEventListener').mockImplementation(record);
  const onDocument = vi.spyOn(document, 'addEventListener').mockImplementation(record);
  new Function(SCRIPT)();
  onWindow.mockRestore();
  onDocument.mockRestore();
  return { message: listeners['message']!, click: listeners['click']! };
}

const handshake = (message: Listener, port: FakePort, init: Record<string, unknown> = {}) =>
  message({
    source: window.parent,
    origin: window.location.origin,
    data: { type: PREVIEW_PORT_MESSAGE },
    ports: [port],
    ...init,
  });

/** An instance that has been handed its port, and what it draws. */
function ready() {
  const instance = start();
  const port: FakePort = { onmessage: null };
  handshake(instance.message, port);
  const send = (html: unknown) => port.onmessage!({ data: { type: PREVIEW_MESSAGE, html } });
  return { ...instance, port, send };
}

const text = () => document.body.textContent?.trim();

beforeEach(() => {
  document.documentElement.innerHTML = PAGE.replace(/<script[^>]*><\/script>/, '');
});

describe('the preview document script', () => {
  it('is served as it is: no innerHTML, no document.write, no eval, no postMessage back', () => {
    expect(SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|postMessage/);
    expect(PAGE).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(PAGE).not.toMatch(/\son\w+=/);
  });

  it('draws the body of the HTML it receives on its port, keeping the attributes of the body', () => {
    const { send } = ready();
    send('<html><body style="background:#eee" class="a"><table><tr><td style="color:red">Ciao</td></tr></table></body></html>');
    expect(text()).toBe('Ciao');
    expect(document.body.getAttribute('style')).toBe('background:#eee');
    expect(document.querySelector('td')?.getAttribute('style')).toBe('color:red');
    send('<p>dopo</p>');
    expect(document.body.hasAttribute('style')).toBe(false);
    expect(document.body.hasAttribute('class')).toBe(false);
    expect(text()).toBe('dopo');
  });

  it('keeps the styles of the head, and replaces them at the next message', () => {
    const { send } = ready();
    send('<html><head><style>p{color:red}</style></head><body><p>uno</p></body></html>');
    expect(document.head.querySelectorAll('style')).toHaveLength(1);
    send('<p>due</p>');
    expect(document.head.querySelectorAll('style')).toHaveLength(0);
    expect(text()).toBe('due');
  });

  it('removes what could take the document elsewhere or run code: refresh, base, scripts, frames, links and handlers', () => {
    const { send } = ready();
    send(
      '<head><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/a.css"></head>' +
        '<body onload="x()"><script>window.pwned = 1</script><noscript>n</noscript><iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">' +
        '<img src="https://img.example/a.png" onerror="window.pwned = 1"><a href="javascript:window.pwned=1" onclick="window.pwned=1">go</a></body>',
    );
    for (const selector of ['meta', 'base', 'script', 'link', 'noscript', 'iframe', 'object', 'embed']) {
      expect(document.body.querySelector(selector), selector).toBeNull();
    }
    expect(document.querySelector('meta[http-equiv], base, link')).toBeNull();
    expect(document.body.hasAttribute('onload')).toBe(false);
    expect(document.querySelector('img')?.hasAttribute('onerror')).toBe(false);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://img.example/a.png');
    expect(document.querySelector('a')?.hasAttribute('onclick')).toBe(false);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it('keeps drawing after an HTML that shadows the properties of the document (DOM clobbering)', () => {
    const { send } = ready();
    // In the document that is parsed (a browser, and jsdom, lets the elements named like that cover its properties) and in the one drawn.
    send('<img name="querySelectorAll"><img name="importNode"><form name="head"></form><img name="body"><img name="addEventListener"><form><input name="attributes"><input name="removeAttribute"></form><p>uno</p>');
    // The drawn elements now cover the properties of `document` (jsdom, like a browser, does it): the script must not read them after it started.
    expect(typeof (document as unknown as Record<string, unknown>)['querySelectorAll']).not.toBe('function');
    try {
      send('<html><head><style>p{color:red}</style></head><body style="color:blue"><p>due</p></body></html>');
      expect(text()).toBe('due');
      expect(document.head.querySelectorAll('style')).toHaveLength(1);
      send('<p>tre</p>');
      expect(text()).toBe('tre');
    } finally {
      document.documentElement.innerHTML = '';
    }
  });

  it('takes the port only from the parent window, from the application origin, once', () => {
    const wrongSource = start();
    const port: FakePort = { onmessage: null };
    handshake(wrongSource.message, port, { source: null });
    handshake(wrongSource.message, port, { source: {} });
    handshake(wrongSource.message, port, { origin: 'https://evil.example' });
    handshake(wrongSource.message, port, { origin: 'null' });
    expect(port.onmessage).toBeNull();
    handshake(wrongSource.message, port);
    expect(port.onmessage).not.toBeNull();
    const intruder: FakePort = { onmessage: null };
    handshake(wrongSource.message, intruder);
    expect(intruder.onmessage).toBeNull();
  });

  it('ignores a handshake of another shape', () => {
    const { message } = start();
    const port: FakePort = { onmessage: null };
    for (const data of [null, 'testo', 5, {}, { type: PREVIEW_MESSAGE, html: '<p>x</p>' }]) {
      handshake(message, port, { data });
    }
    handshake(message, port, { ports: [] });
    handshake(message, port, { ports: undefined });
    handshake(message, port, { ports: [port, port] });
    expect(port.onmessage).toBeNull();
  });

  it('ignores a message on the port of another shape or too large, and keeps what it drew', () => {
    const { send, port } = ready();
    send('<p>buono</p>');
    for (const data of [null, 'testo', 5, {}, { type: 'other', html: '<p>altro</p>' }, { type: PREVIEW_MESSAGE }, { type: PREVIEW_MESSAGE, html: 5 }]) {
      port.onmessage!({ data });
    }
    send('a'.repeat(1_000_001));
    expect(text()).toBe('buono');
    send('a'.repeat(1_000_000));
    expect(text()?.length).toBe(1_000_000);
  });

  it('never lets a link go anywhere, and leaves the other clicks alone, whatever the elements are named', () => {
    const { send, click } = ready();
    send('<a href="https://example.com"><b>vai</b></a><span>x</span>');
    const clicked = (target: unknown): boolean => {
      const event = { target, preventDefault: vi.fn() };
      click(event);
      return event.preventDefault.mock.calls.length > 0;
    };
    expect(clicked(document.querySelector('b'))).toBe(true);
    expect(clicked(document.querySelector('a'))).toBe(true);
    expect(clicked(document.querySelector('span'))).toBe(false);
    expect(clicked(document)).toBe(false);
    const named = document.createElement('a');
    Object.defineProperty(named, 'closest', { value: document.createElement('input') });
    expect(clicked(named)).toBe(true);
  });
});
