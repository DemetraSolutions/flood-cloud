import { Component, computed, inject, resource, signal } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { HasFeature } from '../../core/groups/has-feature';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi, ReferenceItem } from '../../core/reference/reference-api';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Select } from '../../shared/ui/select/select';
import { ReferenceLoader, ReferencePicker } from './reference-picker';
import { UserFormState } from './user-form-state';
import { hasGroupDuties } from './user-model';

/**
 * Perimeter of the user: the companies (CA) or stores (PA, E) of the group, filtered by company
 * when the signed-in user may read the companies, and, when the group has the services feature
 * and the user is an SA, CA or PA, the services the user can perform.
 */
@Component({
  selector: 'fc-user-scope-section',
  imports: [FormField, HasFeature, ReferencePicker, Select, TPipe],
  templateUrl: './user-scope-section.html',
  styleUrl: './user-section.css',
})
export class UserScopeSection {
  protected readonly state = inject(UserFormState);
  private readonly reference = inject(ReferenceApi);
  private readonly store = inject(ReferenceStore);
  protected readonly form = this.state.userForm;

  protected readonly showCompanyFilter = computed(
    () => this.state.groupId() !== undefined && this.state.canReadCompanies(),
  );
  protected readonly companyFilter = signal('');
  private readonly companiesResource = resource({
    params: () =>
      this.showCompanyFilter() && this.state.scopeKind() === 'places'
        ? (this.state.groupId() as string)
        : undefined,
    loader: ({ params }) => this.store.page(params, 'companies', { limit: 200 }),
  });
  protected readonly companyOptions = computed(() =>
    (this.companiesResource.hasValue() ? this.companiesResource.value().data : []).map(
      (company) => ({ value: company.id, label: company.name }),
    ),
  );
  protected readonly companyLoader = computed<ReferenceLoader>(
    () => (query) => this.reference.companies(this.state.groupId() as string, query),
  );
  protected readonly placeLoader = computed<ReferenceLoader>(() => {
    const companyId = this.companyFilter();
    return (query) =>
      this.reference.places(this.state.groupId() as string, {
        ...query,
        companyId: companyId === '' ? undefined : companyId,
      });
  });
  protected readonly dutiesRole = computed(() => hasGroupDuties(this.state.role()));
  protected readonly nothing = computed(
    () => this.state.scopeKind() === 'none' && !this.state.servicesApply(),
  );
}
