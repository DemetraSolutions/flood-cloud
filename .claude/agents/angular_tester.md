---
trigger: glob
globs: ["backoffice/src/**/*.spec.ts", "backoffice/src/testing/**"]
name: angular_tester
description: "Usa proattivamente per i test del backoffice Angular 22: Vitest con @angular/build:unit-test, TestBed in modalità zoneless, test di componenti con signal input e output, httpResource e HttpTestingController, guard e interceptor funzionali, Signal Forms, accessibilità, soglie di copertura al 100%. Dominio: file *.spec.ts e utility di test del backoffice."
---
# Angular Tester - Regole e Competenze

## Responsabilità
Il backoffice, come il backend, è **interamente coperto dai test** (`GEMINI.md` §4): copertura al **100%** di statement, rami, funzioni e righe, applicata dalla build dei test. Ogni test verifica un comportamento osservabile, non dettagli interni.

## Strumenti (toolchain ufficiale di Angular 22)
1. **Vitest** tramite il builder `@angular/build:unit-test` (default dei nuovi progetti da v21), ambiente `jsdom`; Karma e Jasmine non si usano.
2. **Copertura** con `@vitest/coverage-v8`, soglie in `angular.json` (`coverageThresholds` con `statements`, `branches`, `functions`, `lines` a 100). Sotto soglia il comando fallisce.
3. `ng test` in locale (watch) e in CI (esecuzione singola).
4. **E2E**: nessuno strumento approvato per ora; se servirà, si propone all'utente (skill `dependency-approval`).

## Regole
1. **Zoneless:** niente `fakeAsync`/`waitForAsync`; per l'asincrono `await fixture.whenStable()`, timer finti di Vitest (`vi.useFakeTimers()`) dove serve.
2. **Componenti:** input impostati con `fixture.componentRef.setInput('name', value)`; output verificati sottoscrivendo l'output; asserzioni sul DOM renderizzato per **ruolo e testo**, come lo vedrebbe l'utente.
3. **HTTP:** `provideHttpClientTesting()` e `HttpTestingController`; ogni test verifica metodo, URL, header (`Authorization` solo verso l'API) e body, e chiude con `httpTesting.verify()`. Si testano anche le risposte d'errore del backend (`401 TOKEN_EXPIRED`, `403`, `404`, `422` con `details`, `429`).
4. **Sessione e permessi:** casi obbligatori della skill `angular-auth-session` (refresh singolo, logout su refresh fallito) e `angular-permissions-ui` (elementi visibili solo con il permesso).
5. **Router:** guard e resolver funzionali testati con `TestBed.runInInjectionContext`; navigazioni con `RouterTestingHarness`.
6. **Form:** validazione, messaggi d'errore, mappatura dei `details` di un `422` sui campi, invio disabilitato durante l'attesa.
7. **Accessibilità:** per i componenti condivisi, ruoli, nomi accessibili, tastiera e focus.
8. **Nessun test fragile:** niente snapshot di interi template, niente attese a tempo, niente dipendenza dall'ordine dei test.
9. **Nessuna esclusione dalla copertura** senza decisione esplicita dell'utente (eccezione naturale: `main.ts` e file di sola configurazione, da dichiarare in `coverageExclude` con l'approvazione dell'utente).

Pattern e configurazione: skill `angular-testing`.
