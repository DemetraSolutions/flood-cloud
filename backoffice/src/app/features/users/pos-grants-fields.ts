import { Component, inject } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  AutomaticCashDevice,
  POS_GRANT_GROUPS,
  PosFlag,
  posKey,
} from '../../core/users/pos.catalog';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { PosGrantsModel } from './user-model';
import { UserFormState } from './user-form-state';

/**
 * POS permissions of the user form: the grants grouped by area, the two percentages and the
 * automatic cash devices. The controls follow the rules of the state (who may give what): a
 * permission the signed-in user cannot give is disabled and says so; the server has the last
 * word.
 */
@Component({
  selector: 'fc-pos-grants-fields',
  imports: [Checkbox, FormField, TextField, TPipe],
  templateUrl: './pos-grants-fields.html',
  styleUrl: './user-section.css',
})
export class PosGrantsFields {
  protected readonly state = inject(UserFormState);
  private readonly i18n = inject(I18nService);

  protected readonly grants = this.state.userForm.pos.grants as FieldTree<PosGrantsModel>;
  protected readonly groups = POS_GRANT_GROUPS;
  protected readonly devices = AUTOMATIC_CASH_DEVICES;

  protected flagLabel(flag: string): string {
    return this.i18n.t(`USERS.POS.GRANT.${posKey(flag)}`);
  }

  protected groupLabel(id: string): string {
    return this.i18n.t(`USERS.POS.GRANT_GROUP.${id}`);
  }

  protected deviceLabel(device: string): string {
    return this.i18n.t(`USERS.POS.DEVICE.${posKey(device)}`);
  }

  protected automaticLabel(key: string): string {
    return this.i18n.t(`USERS.POS.AUTOMATIC_FLAG.${posKey(key)}`);
  }

  protected keysOf(device: AutomaticCashDevice): readonly string[] {
    return AUTOMATIC_CASH[device];
  }

  protected flagField(flag: PosFlag): FieldTree<boolean> {
    return this.grants[flag];
  }

  protected automaticField(device: AutomaticCashDevice, key: string): FieldTree<boolean> {
    return (this.grants.automaticCash[device] as unknown as Record<string, FieldTree<boolean>>)[
      key
    ];
  }

  /** Hint of a permission the signed-in user cannot give. */
  protected flagHint(flag: PosFlag): string | null {
    return this.state.posGrantsEditable() && !this.state.canGiveFlag(flag)
      ? this.i18n.t('USERS.POS.NOT_GRANTABLE')
      : null;
  }

  protected automaticHint(device: AutomaticCashDevice, key: string): string | null {
    return this.state.posGrantsEditable() && !this.state.canGiveAutomatic(device, key)
      ? this.i18n.t('USERS.POS.NOT_GRANTABLE')
      : null;
  }

  protected error(field: FieldTree<unknown>): string | null {
    return this.state.error(field);
  }
}
