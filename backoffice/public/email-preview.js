/*
 * Preview document of the e-mail templates (`doc/Technical-Guide.md`, step T2). It runs in a frame of the
 * backoffice with `sandbox="allow-scripts"` (opaque origin, never `allow-same-origin`; the policy of
 * `server/headers.ts` also says `sandbox allow-scripts`, so the origin is opaque in any context) and under its
 * own Content-Security-Policy (`script-src 'self'`: only THIS file runs, never the scripts or the handlers of
 * the e-mail). The page that framed us hands over a MessageChannel port once; the HTML then comes only on that
 * port. This file checks who sent the port, neutralises what could take the document elsewhere, and draws the
 * HTML. It is plain JavaScript because it is not part of the Angular build: the file is served as it is, by the
 * static server and by `ng serve`.
 *
 * DOM clobbering: the HTML of the e-mail ends up in this very document, where an element such as
 * `<img name="querySelectorAll">` or `<form name="head">` shadows the properties of `document`. So everything
 * this file needs (the window of the page above, the origin, the body, the head and the native methods) is
 * taken ONCE, when the script starts and the document holds no e-mail yet, and `document.*` is never read again.
 */
(function () {
  'use strict';

  var PORT_TYPE = 'fc-email-preview-port';
  var TYPE = 'fc-email-preview';
  /** Largest HTML accepted, in characters: the server's own limit is 256 KB, this leaves room for multi-byte text. */
  var MAX_LENGTH = 1000000;
  /** Elements that never reach the page: they can navigate, load code or restyle the document. */
  var REMOVED = 'meta, base, script, link, iframe, frame, frameset, object, embed, applet, noscript';

  var doc = document;
  var win = window;
  var parentWindow = win.parent;
  // `location.origin` is the origin of the URL of this document, i.e. the backoffice: on purpose, and not `self.origin`,
  // which is "null" in a sandbox without `allow-same-origin` (and `event.origin === 'null'` would admit any sandboxed frame).
  var appOrigin = win.location.origin;
  var body = doc.body;
  var head = doc.head;
  // The native functions, taken once. They are always called on the object with `.call`: an element named like a
  // property (`<img name="querySelectorAll">` on a document, `<input name="attributes">` in a form) would shadow it.
  var importNode = Document.prototype.importNode;
  var queryAllOfDocument = Document.prototype.querySelectorAll;
  var queryAllOfElement = Element.prototype.querySelectorAll;
  var bodyOfDocument = Object.getOwnPropertyDescriptor(Document.prototype, 'body').get;
  var headOfDocument = Object.getOwnPropertyDescriptor(Document.prototype, 'head').get;
  var attributesOf = Object.getOwnPropertyDescriptor(Element.prototype, 'attributes').get;
  var childNodesOf = Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes').get;
  var removeElement = Element.prototype.remove;
  var removeAttribute = Element.prototype.removeAttribute;
  var setAttribute = Element.prototype.setAttribute;
  var replaceChildren = Element.prototype.replaceChildren;
  var closest = Element.prototype.closest;
  var slice = Array.prototype.slice;
  var drawnStyles = [];
  var port = null;

  function neutralise(parsed) {
    slice.call(queryAllOfDocument.call(parsed, REMOVED)).forEach(function (node) {
      removeElement.call(node);
    });
    slice.call(queryAllOfDocument.call(parsed, '*')).forEach(function (element) {
      slice.call(attributesOf.call(element)).forEach(function (attribute) {
        // Handlers are blocked by the policy anyway; a `javascript:` address never runs for the same reason.
        if (/^on/i.test(attribute.name)) {
          removeAttribute.call(element, attribute.name);
        }
      });
    });
  }

  function render(html) {
    // The parsed document is never attached: nothing in it runs, loads or redirects while it is being cleaned.
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    neutralise(parsed);
    var parsedBody = bodyOfDocument.call(parsed);
    drawnStyles.forEach(function (style) {
      removeElement.call(style);
    });
    drawnStyles = [];
    slice.call(queryAllOfElement.call(headOfDocument.call(parsed), 'style')).forEach(function (style) {
      var copy = importNode.call(doc, style, true);
      head.appendChild(copy);
      drawnStyles.push(copy);
    });
    slice.call(attributesOf.call(body)).forEach(function (attribute) {
      removeAttribute.call(body, attribute.name);
    });
    slice.call(attributesOf.call(parsedBody)).forEach(function (attribute) {
      setAttribute.call(body, attribute.name, attribute.value);
    });
    replaceChildren.apply(body, slice.call(childNodesOf.call(importNode.call(doc, parsedBody, true))));
  }

  function accept(message) {
    if (
      typeof message === 'object' &&
      message !== null &&
      message.type === TYPE &&
      typeof message.html === 'string' &&
      message.html.length <= MAX_LENGTH
    ) {
      render(message.html);
    }
  }

  win.addEventListener('message', function (event) {
    // The port is taken once, from the page that framed us and only if it is the application (the origin of this very document).
    // A frame that navigates elsewhere gets a new document without a port: the page can no longer reach it.
    if (port !== null || event.source !== parentWindow || event.origin !== appOrigin) {
      return;
    }
    var message = event.data;
    if (typeof message !== 'object' || message === null || message.type !== PORT_TYPE || !event.ports || event.ports.length !== 1) {
      return;
    }
    port = event.ports[0];
    port.onmessage = function (portEvent) {
      accept(portEvent.data);
    };
  });

  // Links are only a preview: they go nowhere (the sandbox has no popups and no navigation of the page above).
  doc.addEventListener('click', function (event) {
    if (event.target instanceof Element && closest.call(event.target, 'a, area')) {
      event.preventDefault();
    }
  });
})();
