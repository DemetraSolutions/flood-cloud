---
name: angular-testing
description: Usa quando scrivi o configuri test del backoffice Angular 22: Vitest con @angular/build:unit-test, soglie di copertura al 100% in angular.json, TestBed zoneless, componenti con setInput, HttpTestingController, guard e interceptor funzionali, RouterTestingHarness.
---
# Angular Testing (v22, Vitest)

## Configurazione
- Runner predefinito dei nuovi progetti: **Vitest** tramite `@angular/build:unit-test`, ambiente `jsdom`. Karma è deprecato e non si usa.
- Copertura con `@vitest/coverage-v8`; in `angular.json`, opzioni del target `test`:
```json
{
  "builder": "@angular/build:unit-test",
  "options": {
    "coverage": true,
    "coverageThresholds": { "statements": 100, "branches": 100, "functions": 100, "lines": 100 },
    "coverageReporters": ["text", "html", "lcov"]
  }
}
```
Verifica i nomi esatti delle opzioni con `ng test --help` della versione installata. Le esclusioni dalla copertura (`coverageExclude`) richiedono l'approvazione dell'utente.
- `ng test` in locale (watch), in CI esecuzione singola con copertura.

## Componente
```ts
describe('ProductRow', () => {
  it('emits the product id when edit is clicked', async () => {
    const fixture = TestBed.createComponent(ProductRow);
    fixture.componentRef.setInput('product', aProduct({ id: 'p1' }));
    fixture.componentRef.setInput('canEdit', true);
    const emitted: string[] = [];
    fixture.componentInstance.edit.subscribe((id) => emitted.push(id));
    await fixture.whenStable();

    screenButton(fixture, 'Modifica').click();

    expect(emitted).toEqual(['p1']);
  });
});
```
- Zoneless: dopo ogni cambiamento `await fixture.whenStable()`; niente `fakeAsync`.
- Asserzioni sul DOM per ruolo e testo visibile (helper condivisi in `src/testing/`).

## HTTP
```ts
TestBed.configureTestingModule({ providers: [provideHttpClientTesting(), { provide: APP_CONFIG, useValue: testConfig }] });
const httpTesting = TestBed.inject(HttpTestingController);
// ... trigger the request
const req = httpTesting.expectOne(`${testConfig.apiBaseUrl}/v1/groups/g1/products?status=active`);
expect(req.request.method).toBe('GET');
req.flush({ data: [], page: { limit: 50, next: null } });
httpTesting.verify();
```
Per gli errori: `req.flush(errorBody, { status: 422, statusText: 'Unprocessable Entity' })`.

## Guard, resolver, interceptor
- Funzioni eseguite in `TestBed.runInInjectionContext(() => guard(route, segments))`.
- Interceptor provati attraverso `HttpClient` reale configurato con `provideHttpClient(withInterceptors([...]))` + `provideHttpClientTesting()`.
- Navigazione con `RouterTestingHarness.create()` e `harness.navigateByUrl(...)`.

## Tempo
`vi.useFakeTimers()` per debounce e scadenze, sempre ripristinati (`vi.useRealTimers()`) a fine test.

## Fixture di dati
Builder di dati di test (`aProduct({...})`) in `src/testing/`, con valori fittizi evidenti; nessun dato reale, nessun token reale.
