---
name: node-typescript
description: Usa quando configuri o scrivi TypeScript nel backend Node 24: esecuzione diretta con type stripping nativo, tsconfig, sola sintassi cancellabile (niente enum, namespace, parameter properties), import con estensione .ts e import type, controllo dei tipi con tsc in CI.
---
# Node TypeScript (type stripping)

Decisione dell'utente del 2026-11-01: il backend è in **TypeScript eseguito direttamente da Node 24**, che rimuove i tipi al caricamento (type stripping, attivo di default; `process.features.typescript === 'strip'`). Nessuna compilazione, nessun `ts-node`/`tsx`/bundler. Verificato su Node 24.20: avvio, `node:test` e copertura nativa funzionano sui sorgenti `.ts`.

## Dipendenze (solo sviluppo)
`typescript` per il controllo dei tipi e i pacchetti `@types/*` delle librerie approvate che non includono i propri tipi (`@types/node`, `@types/express`, `@types/body-parser`, `@types/compression`, `@types/multer`; `mongodb` ha già i tipi). Ultime versioni stabili, versioni esatte. Nessun'altra dipendenza di sviluppo senza approvazione.

## tsconfig.json
```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```
Verifica le opzioni con la versione di TypeScript installata (`npx tsc --showConfig`).

## Script
```json
{
  "type": "module",
  "scripts": {
    "start": "node src/server.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --test --experimental-test-coverage --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 --test-coverage-include=src/** \"test/**/*.test.ts\""
  }
}
```
In CI girano **sia** `npm run typecheck` **sia** `npm test`: Node non controlla i tipi, li cancella soltanto.

## Sintassi ammessa
Solo sintassi **cancellabile** (garantita da `erasableSyntaxOnly`):
| Vietato | Usa invece |
|---|---|
| `enum Role { … }` | `const ROLES = ['PSA', 'D', 'SA'] as const; type Role = (typeof ROLES)[number];` |
| `namespace` | moduli ES |
| `constructor(private readonly repo: Repo)` | campo dichiarato e assegnato nel corpo del costruttore |
| decorator con emissione di metadati | funzioni e composizione esplicita |
| `import x = require('x')` | `import x from 'x'` |

## Import
- Relativi **con estensione `.ts`**: `import { createApp } from './app.ts';`
- Solo tipi con `import type`: `import type { Db } from 'mongodb';`
- Moduli nativi con prefisso `node:`.

## Tipi
- Niente `any`: `unknown` + restringimento per tutto ciò che arriva dall'esterno (body, query, risposte dei provider, errori nei `catch`).
- Tipi derivati dagli schemi di validazione dove possibile, così schema e tipo non divergono.
- Documenti MongoDB tipizzati per collection (`Collection<UserDocument>`), DTO di risposta separati dai documenti.
- `readonly` per dati che non devono cambiare; `as const` per tabelle di costanti.
- JSDoc in inglese per descrizioni ed esempi; i tipi stanno nel codice, non tra graffe nel JSDoc.

## Tipi condivisi con il backoffice
I tipi del contratto API potranno essere condivisi con `backoffice/` (stesso linguaggio). Dove e come condividerli è una decisione da prendere con l'utente quando serve: non crearla in anticipo.
