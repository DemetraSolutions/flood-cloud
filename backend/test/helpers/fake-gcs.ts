import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An object the fake bucket holds. */
export interface FakeObject {
  readonly bytes: Buffer;
  /** The generation number, as GCS gives it. */
  readonly generation?: string;
  readonly contentType: string;
  readonly cacheControl: string | undefined;
}

/** One request the fake received. */
export interface FakeRequest {
  readonly method: string;
  /** Path without the query. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
}

/** What a scripted answer does instead of the normal behavior. */
export interface FakeAnswer {
  /** Answer this status with an empty body. */
  readonly status?: number;
  /** Never answer (the client's timeout fires). */
  readonly hang?: true;
  /** Close the connection without an answer. */
  readonly drop?: true;
  /** For an upload: store the object first, then close the connection without an answer (a lost response). */
  readonly storeThenDrop?: true;
  /** Answer 200 with this raw text instead of the normal body. */
  readonly raw?: string;
}

/** A fake Google Cloud Storage, token endpoint and metadata server in one local HTTP server. */
export interface FakeGcs {
  /** `http://127.0.0.1:<port>`: the storage base URL. */
  readonly baseUrl: string;
  /** URL of the fake OAuth token endpoint (a service-account JWT is exchanged here). */
  readonly tokenUrl: string;
  /** URL of the fake metadata token endpoint. */
  readonly metadataUrl: string;
  /** The objects by name. */
  readonly objects: Map<string, FakeObject>;
  /** Every request, in order. */
  readonly requests: FakeRequest[];
  /** The claims of the JWTs the token endpoint accepted. */
  readonly claims: Array<Record<string, unknown>>;
  /** The public key the token endpoint verifies the JWT signature with. */
  publicKey: KeyObject | null;
  /** Decides, per request, whether to answer something else than the normal behavior; consulted before anything else. */
  intercept: ((request: FakeRequest) => FakeAnswer | undefined) | null;
  /** Milliseconds the token endpoints wait before answering. */
  tokenDelayMs: number;
  /** `expires_in` the token endpoints answer. */
  expiresIn: number;
  /** Counter of generations. */
  generations: number;
  /** The tokens issued so far (so a test can tell which one a call used). */
  issued: number;
  close(): Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });

/** Splits a `multipart/related` upload into its metadata and its media part. */
export function parseRelated(body: Buffer, contentType: string): { metadata: Record<string, unknown>; media: Buffer; mediaType: string } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (boundary === undefined) {
    throw new Error('no boundary');
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const first = body.indexOf(delimiter);
  const second = body.indexOf(delimiter, first + delimiter.length);
  const third = body.indexOf(delimiter, second + delimiter.length);
  const split = (part: Buffer): { headers: string; content: Buffer } => {
    const end = part.indexOf('\r\n\r\n');
    return { headers: part.subarray(0, end).toString(), content: part.subarray(end + 4) };
  };
  const meta = split(body.subarray(first + delimiter.length + 2, second - 2));
  const media = split(body.subarray(second + delimiter.length + 2, third - 2));
  return { metadata: JSON.parse(meta.content.toString()) as Record<string, unknown>, media: media.content, mediaType: /Content-Type: (.+)/i.exec(media.headers)?.[1] ?? '' };
}

/** A throw-away RSA key pair: the private key as a PEM (for a credentials file) and the public key (to verify a JWT). Generated at test time, never stored. */
export function testKeyPair(): { privatePem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicKey };
}

/** The text of a service-account credentials file for a key; `token_uri` points where the test says (to prove it is ignored). */
export function credentialsFile(privatePem: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'service_account', client_email: 'uploader@project.iam.gserviceaccount.example', private_key: privatePem, token_uri: 'http://127.0.0.1:1/never', ...extra });
}

/** Starts the fake on an ephemeral port. */
export async function startFakeGcs(): Promise<FakeGcs> {
  const fake: FakeGcs = {
    baseUrl: '',
    tokenUrl: '',
    metadataUrl: '',
    objects: new Map(),
    requests: [],
    claims: [],
    publicKey: null,
    intercept: null,
    tokenDelayMs: 0,
    expiresIn: 3600,
    issued: 0,
    generations: 0,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  const send = (response: ServerResponse, status: number, body?: unknown): void => {
    response.statusCode = status;
    if (body === undefined) {
      response.end();
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(body));
    }
  };
  const token = async (response: ServerResponse): Promise<void> => {
    if (fake.tokenDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, fake.tokenDelayMs));
    }
    fake.issued += 1;
    send(response, 200, { access_token: `token-${String(fake.issued)}`, expires_in: fake.expiresIn, token_type: 'Bearer' });
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fake');
      const recorded: FakeRequest = { method: request.method ?? '', path: url.pathname, query: url.searchParams, headers: request.headers, body: await readBody(request) };
      fake.requests.push(recorded);
      const scripted = fake.intercept?.(recorded);
      const objectPath = /^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/.exec(url.pathname);
      const store = (): boolean => {
        const { metadata, media, mediaType } = parseRelated(recorded.body, String(request.headers['content-type']));
        const name = url.searchParams.get('name') ?? '';
        if (metadata['name'] !== name) {
          return false;
        }
        if (url.searchParams.get('ifGenerationMatch') === '0' && fake.objects.has(name)) {
          return false;
        }
        if (typeof metadata['md5Hash'] === 'string' && metadata['md5Hash'] !== createHash('md5').update(media).digest('base64')) {
          return false;
        }
        fake.generations += 1;
        fake.objects.set(name, { bytes: media, generation: String(fake.generations), contentType: mediaType, cacheControl: metadata['cacheControl'] as string | undefined });
        return true;
      };
      if (scripted?.hang === true) {
        return;
      }
      if (scripted?.drop === true) {
        request.socket.destroy();
        return;
      }
      if (scripted?.storeThenDrop === true) {
        store();
        request.socket.destroy();
        return;
      }
      if (scripted?.status !== undefined) {
        send(response, scripted.status);
        return;
      }
      if (scripted?.raw !== undefined) {
        response.statusCode = 200;
        response.end(scripted.raw);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const assertion = new URLSearchParams(recorded.body.toString()).get('assertion') ?? '';
        const [header, claims, signature] = assertion.split('.');
        const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
        if (fake.publicKey === null || !verifier.verify(fake.publicKey, Buffer.from(signature ?? '', 'base64url'))) {
          send(response, 400, { error: 'invalid_grant' });
          return;
        }
        fake.claims.push(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString()) as Record<string, unknown>);
        await token(response);
      } else if (request.method === 'GET' && url.pathname === '/computeMetadata/v1/instance/service-accounts/default/token') {
        if (request.headers['metadata-flavor'] !== 'Google') {
          send(response, 403);
          return;
        }
        await token(response);
      } else if (request.method === 'POST' && /^\/upload\/storage\/v1\/b\/[^/]+\/o$/.test(url.pathname)) {
        if (!/^Bearer token-\d+$/.test(String(request.headers['authorization']))) {
          send(response, 401);
          return;
        }
        const stored = store();
        send(response, stored ? 200 : 412, stored ? { generation: String(fake.generations) } : undefined);
      } else if (request.method === 'DELETE' && objectPath !== null) {
        const name = decodeURIComponent(objectPath[1] as string);
        const existing = fake.objects.get(name);
        const wanted = url.searchParams.get('ifGenerationMatch');
        if (existing === undefined) {
          send(response, 404);
        } else if (wanted !== null && wanted !== (existing.generation ?? '1')) {
          send(response, 412);
        } else {
          fake.objects.delete(name);
          send(response, 204);
        }
      } else if (request.method === 'GET' && objectPath !== null) {
        const found = fake.objects.get(decodeURIComponent(objectPath[1] as string));
        send(
          response,
          found === undefined ? 404 : 200,
          found === undefined ? undefined : { size: String(found.bytes.length), generation: found.generation ?? '1', md5Hash: createHash('md5').update(found.bytes).digest('base64') },
        );
      } else {
        send(response, 404);
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return Object.assign(fake, { baseUrl: origin, tokenUrl: `${origin}/token`, metadataUrl: `${origin}/computeMetadata/v1/instance/service-accounts/default/token` });
}
