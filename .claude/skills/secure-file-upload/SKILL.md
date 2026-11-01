---
name: secure-file-upload
description: Usa quando implementi upload di file con multer (immagini, import CSV/XLSX, documenti): limiti, verifica dei magic bytes, nomi generati dal server, storage non pubblico, gestione degli errori di multer.
---
# Secure File Upload (multer)

## Configurazione
```js
import multer from 'multer';

/**
 * Upload middleware for a single in-memory file, with strict limits.
 * @param {{ fieldName: string, maxBytes: number }} options
 * @returns {import('express').RequestHandler}
 */
export function singleUpload({ fieldName, maxBytes }) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 10 * 1024, parts: 12, headerPairs: 50 },
  }).single(fieldName);
}
```
- `memoryStorage` solo con `fileSize` piccolo; per file grandi (import massivi) usa lo storage su disco in una cartella temporanea **fuori** da qualsiasi cartella servita, con pulizia garantita.
- Montato solo sulla route di upload, dopo autenticazione e autorizzazione (prima non si accetta il corpo).

## Verifica del contenuto
Il `mimetype` e l'estensione arrivano dal client: **non sono affidabili**. Dopo multer verifica i magic bytes del buffer:
| Tipo | Firma iniziale |
|---|---|
| PNG | `89 50 4E 47 0D 0A 1A 0A` |
| JPEG | `FF D8 FF` |
| WebP | `52 49 46 46` … `57 45 42 50` (byte 8–11) |
| PDF | `25 50 44 46 2D` |
| XLSX (zip) | `50 4B 03 04` + controllo del contenuto |
Tipo non in allowlist ⇒ 415. **SVG e HTML rifiutati** (XSS memorizzato).

## Nomi e storage
- Nome generato dal server (`randomUUID()` + estensione derivata dal tipo verificato); `originalname` si salva solo come metadato, sanificato e troncato.
- Mai servire file da `express.static` o da cartelle pubbliche: si scaricano da endpoint autenticato con `Content-Disposition` e `X-Content-Type-Options: nosniff`, oppure da storage esterno con URL firmati a scadenza.
- Percorsi costruiti solo da identificativi del server, mai da input del client (path traversal).

## Errori
`MulterError` con `code === 'LIMIT_FILE_SIZE'` ⇒ 413; altri codici `LIMIT_*` ⇒ 400; tipo non ammesso ⇒ 415. Tutto passa dal gestore centrale (skill `express-error-handling`).

## Test
File valido, troppo grande, più file, campo sbagliato, mimetype dichiarato falso (es. PNG con contenuto HTML), SVG, nome con `../`, utente senza permesso (nessun file elaborato).
