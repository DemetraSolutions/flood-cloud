import { Component, inject } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { TPipe } from '../../core/i18n/t-pipe';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { UserFormState } from './user-form-state';
import { PermissionModule, PERMISSION_MODULES } from './user.types';

/**
 * Permission matrix: read and write per module (`logs` read only) and "manages permissions". Only
 * who manages permissions edits it; PSA and D always have every permission, so theirs is shown and
 * never edited. When creating, nothing is sent unless the creator chooses to define it now.
 */
@Component({
  selector: 'fc-user-permissions-section',
  imports: [Checkbox, FormField, TPipe],
  templateUrl: './user-permissions-section.html',
  styleUrl: './user-section.css',
})
export class UserPermissionsSection {
  protected readonly state = inject(UserFormState);
  protected readonly matrix = this.state.userForm.permissions;
  protected readonly modules = PERMISSION_MODULES;

  protected moduleLabel(module: string): string {
    return this.state.i18n.t(`USERS.MODULE.${module.toUpperCase()}`);
  }

  protected flag(module: PermissionModule, flag: 'r' | 'w'): FieldTree<boolean> {
    return this.matrix.modules[module][flag];
  }

  /** Hint of a flag the signed-in user cannot give. */
  protected hint(module: PermissionModule, flag: 'r' | 'w'): string | null {
    return this.state.matrixEditable() && !this.state.canGiveModule(module, flag)
      ? this.state.i18n.t('USERS.FORM.NOT_GRANTABLE')
      : null;
  }
}
