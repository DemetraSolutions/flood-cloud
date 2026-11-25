import { Provider, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { disabled, form, SchemaPath, validate } from '@angular/forms/signals';
import { Countries } from '../app/core/reference/countries';
import { I18nService } from '../app/core/i18n/i18n.service';
import { ContactModel, toModel } from '../app/features/contacts/contact-model';
import { provideApiTesting } from './api';

/** The Signal Form of a contact for the host of a section: read only on demand, with a server error on demand. */
export function contactSectionForm(initial: ContactModel = toModel(null)) {
  const model = signal(initial);
  const readOnly = signal(false);
  const serverError = signal<string | null>(null);
  const tree = form(model, (path) => {
    const server = <T>(field: SchemaPath<T>) =>
      validate(field, () => {
        const message = serverError();
        return message === null ? undefined : { kind: 'server', message };
      });
    server(path.person.firstName);
    server(path.person.lastName);
    server(path.person.taxCode);
    server(path.person.birthDate);
    server(path.person.discountPercent);
    server(path.person.phones);
    server(path.person.emails);
    server(path.person.associatedCompanyId);
    server(path.company.name);
    server(path.company.vatNumber);
    server(path.company.taxCode);
    server(path.company.discountPercent);
    server(path.company.phones);
    server(path.company.emails);
    server(path.company.faxes);
    server(path.company.supplierPriceLists);
    disabled(path, () => readOnly());
  });
  return { model, readOnly, serverError, tree };
}

/** Providers and translations of the hosts of the sections of the contact page. */
export function configureContactSection(providers: Provider[] = []): void {
  TestBed.configureTestingModule({
    providers: [
      ...provideApiTesting(),
      ...providers,
      provideRouter([]),
      { provide: Countries, useValue: { need: vi.fn(), list: () => [], areas: () => [] } },
    ],
  });
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
}
