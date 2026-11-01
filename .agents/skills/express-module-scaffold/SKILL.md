---
name: express-module-scaffold
description: Usa quando crei un nuovo modulo di dominio o una nuova route Express 5: struttura dei file, dichiarazione di route con autenticazione e permesso obbligatori, strati route/controller/service/repository e test corrispondenti.
---
# Express Module Scaffold

## Struttura
```
src/modules/<domain>/
  <domain>.routes.js       # dichiarazione delle route
  <domain>.controller.js   # HTTP ↔ service
  <domain>.service.js      # regole di business, nessun req/res
  <domain>.repository.js   # unico accesso a MongoDB, con contesto di tenant
  <domain>.schemas.js      # schemi di validazione di body/query/params
  <domain>.mapper.js       # documento MongoDB → DTO di risposta
  indexes.js               # indici della collection
test/unit/modules/<domain>/...
test/integration/modules/<domain>.test.js
```
Crea **solo** i file che il passo richiede: un modulo di sola lettura non ha bisogno di schemi di update.

## Route dichiarative (deny by default)
Le route si dichiarano **per superficie** (`backoffice` → `/v1`, `store` → `/store/v1`, `public` → `/public/v1`, `doc/Architecture.md` §4). Ogni superficie ha il proprio middleware di autenticazione, quindi una credenziale vale solo sulla sua superficie.

Il builder condiviso (`src/shared/http/define-routes.js`) monta nell'ordine autenticazione → rate limit → autorizzazione → validazione → handler, e **lancia un errore all'avvio** se una route non dichiara `permission`, a meno che non sia marcata `anonymous: true` con una motivazione.
```js
import { groupParams, listProductsQuery, productIdParams, createProductBody } from './products.schemas.js';

/**
 * Product module routes, grouped by API surface.
 * @param {ReturnType<import('./products.controller.js').createProductsController>} controller
 * @returns {Record<'backoffice'|'store'|'public', import('../../shared/http/define-routes.js').RouteDefinition[]>}
 */
export function productsRoutes(controller) {
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
Le uniche route `anonymous: true` ammesse sono quelle che lo sono per natura (health, login, refresh, attivazione e token dei server di punto vendita, webhook con firma propria), sempre con rate limit e un commento che lo motiva. Percorsi e metodi seguono `doc/API-Guidelines.md`.

## Controller
```js
/**
 * Creates the products controller.
 * @param {{ productsService: ReturnType<import('./products.service.js').createProductsService> }} deps
 */
export function createProductsController({ productsService }) {
  return {
    /** @type {import('express').RequestHandler} */
    async list(req, res) {
      const page = await productsService.list(req.auth, req.valid.query);
      res.json({ data: page.items, page: page.page });
    },
    // ...
  };
}
```
- Il controller legge solo `req.auth` (contesto verificato) e `req.valid` (input validato), mai `req.body`/`req.query` grezzi.

## Checklist del modulo
- [ ] ogni route sulla superficie giusta e con `permission`
- [ ] schemi per ogni input
- [ ] repository con contesto di tenant (skill `tenant-isolation`)
- [ ] indici dichiarati e creati all'avvio
- [ ] test unitari dei service e test di integrazione della catena completa, inclusi i rifiuti di sicurezza
- [ ] `doc/API.md` aggiornato (skill `docs-sync-checklist`)
