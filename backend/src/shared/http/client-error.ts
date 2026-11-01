import type { Duplex } from 'node:stream';
import { DEFAULT_MESSAGES } from './errors.ts';
import { SECURITY_HEADERS } from './security-headers.ts';

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  ERR_HTTP_REQUEST_TIMEOUT: 408,
  HPE_HEADER_OVERFLOW: 431,
};

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  408: 'Request Timeout',
  431: 'Request Header Fields Too Large',
};

/**
 * Handler for the `clientError` event of the HTTP server (unparsable requests,
 * header overflow, request timeout), where Express never runs. A connection reset
 * is simply destroyed. Otherwise, if the socket is still writable, a minimal JSON
 * error (400, 408 for a request timeout, 431 for oversized headers) with the
 * security headers is sent before closing it. All of them use the `BAD_REQUEST` code.
 *
 * @param error The parser error, possibly carrying a `code`.
 * @param socket The client socket.
 */
export function handleClientError(error: Error, socket: Duplex): void {
  const code = (error as { code?: string }).code;
  if (code === 'ECONNRESET' || !socket.writable) {
    socket.destroy();
    return;
  }
  const status = STATUS_BY_CODE[code ?? ''] ?? 400;
  const body = JSON.stringify({ error: { code: 'BAD_REQUEST', message: DEFAULT_MESSAGES.BAD_REQUEST } });
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    Connection: 'close',
  };
  const head = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n${head}\r\n${body}`, () => socket.destroy());
}
