---
name: express-module-scaffold
description: Usa quando crei un nuovo modulo di dominio o una nuova route Express 5: struttura dei file, dichiarazione di route con autenticazione e permesso obbligatori, strati route/controller/service/repository e test corrispondenti.
---
# Express Module Scaffold

## Struttura
```
src/modules/<domain>/
  <domain>.routes.ts       # dichiarazione delle route
  <domain>.controller.ts   # HTTP ↔ service
  <domain>.service.ts      # regole di business, nessun req/res
  <domain>.repository.ts   # unico accesso a MongoDB, con contesto di tenant
  <domain>.schemas.ts      # schemi di validazione di body/query/params
  <domain>.mapper.ts       # documento MongoDB → DTO di risposta
  indexes.ts               # indici della collection
test/unit/modules/<domain>/...
test/integration/modules/<domain>.test.ts
```
Crea **solo** i file che il passo richiede: un modulo di sola lettura non ha bisogno di schemi di update.

## Route dichiarative (deny by default)
Le route si dichiarano **per superficie** (`backoffice` → `/v1`, `public` → `/public/v1`, `doc/Architecture.md` §4). Ogni superficie ha il proprio middleware di autenticazione, quindi una credenziale vale solo sulla sua superficie.

Il builder condiviso (`src/shared/http/define-routes.ts`) monta nell'ordine autenticazione → rate limit → autorizzazione → validazione → handler, e **lancia un errore all'avvio** se una route non dichiara `permission`, a meno che non sia marcata `anonymous: true` con una motivazione.
```ts
import type { RouteDefinition } from '../../shared/http/define-routes.ts';
import type { createProductsController } from './products.controller.ts';
import { groupParams, listProductsQuery, productIdParams, createProductBody } from './products.schemas.ts';

/**
 * Product module routes, grouped by API surface.
 * @param controller products controller
 */
export function productsRoutes(
  controller: ReturnType<typeof createProductsController>,
): Record<'backoffice' | 'store' | 'public', RouteDefinition[]> {
  return {
    backoffice: [
      { method: 'get', path: '/groups/:groupId/products', permission: 'products:read',
        schema: { params: groupParams, query: listProductsQuery }, handler: controller.list },
      { method: 'post', path: '/groups/:groupId/products', permission: 'products:write',
        schema: { params: groupParams, body: createProductBody }, handler: controller.create },
    ],
    store: [
      { method: 'get', path: '/products', permission: 'products:read',
        schema: { query: listProductsQuery }, handler: controller.list },
    ],
    public: [
      { method: 'get', path: '/products/:productId', permission: 'products:read',
        schema: { params: productIdParams }, handler: controller.getById },
    ],
  };
}
```
Una route può essere aperta al server di punto vendita (chiave di negozio, D-24) solo con l'opt-in esplicito `store: true` nell'`auth` (permesso nel `STORE_PROFILE`, gruppo e `:placeId` nel percorso) oppure con `auth: { kind: 'store' }` per le route del solo negozio: senza opt-in una chiave di negozio ha `403` (skill `store-key-auth`).

Le uniche route `anonymous: true` ammesse sono quelle che lo sono per natura (health, login, refresh, webhook con firma propria), sempre con rate limit e un commento che lo motiva. Percorsi e metodi seguono `doc/API-Guidelines.md`.

## Esposizione pubblica (GKE)
Su GKE il bilanciatore inoltra al backend **solo** i prefissi elencati in `backend/k8s/httproute.yaml`: oggi `/v1` e `/public/v1`. Tutto il resto, compreso `/health`, non è raggiungibile da internet.
- Una route nuova va **sempre** dentro una superficie esistente (router di `/v1` o di `/public/v1`), mai montata direttamente sull'app.
- Un prefisso nuovo (es. `/v2`, un endpoint di webhook) è una decisione da chiedere all'utente. Se approvato: si aggiunge ad `API_PREFIXES` in `src/shared/http/surfaces.ts`, si monta in `src/app.ts` con la costante (mai un percorso letterale) e si aggiunge come `PathPrefix` in `backend/k8s/httproute.yaml`.
- `/health` (`HEALTH_PREFIX`) non va mai nella `HTTPRoute`: le sonde arrivano direttamente ai pod.
- `test/unit/route-exposure.test.ts` fallisce se costanti, montaggi e `HTTPRoute` non coincidono, se si espone `/` o `/health`, se si monta un percorso letterale o una route sull'app, o se un altro file crea un'app Express: non si aggira, si allineano i tre file.

## Controller
```ts
import type { RequestHandler } from 'express';
import type { createProductsService } from './products.service.ts';

/** Dependencies of the products controller. */
export interface ProductsControllerDeps {
  productsService: ReturnType<typeof createProductsService>;
}

/**
 * Creates the products controller.
 * @param deps controller dependencies
 */
export function createProductsController({ productsService }: ProductsControllerDeps) {
  return {
    list: (async (req, res) => {
      const page = await productsService.list(req.auth, req.valid.query);
      res.json({ data: page.items, page: page.page });
    }) satisfies RequestHandler,
    // ...
  };
}
```
- Il controller legge solo `req.auth` (contesto verificato) e `req.valid` (input validato), mai `req.body`/`req.query` grezzi.

## Checklist del modulo
- [ ] ogni route sulla superficie giusta e con `permission`
- [ ] nessun prefisso nuovo; se approvato, allineati `surfaces.ts`, `app.ts` e `backend/k8s/httproute.yaml`
- [ ] schemi per ogni input
- [ ] repository con contesto di tenant (skill `tenant-isolation`)
- [ ] indici dichiarati e creati all'avvio
- [ ] test unitari dei service e test di integrazione della catena completa, inclusi i rifiuti di sicurezza
- [ ] `doc/API.md` aggiornato (skill `docs-sync-checklist`)
