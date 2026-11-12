import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  disabled,
  form,
  FormField,
  maxLength,
  ReadonlyFieldTree,
  required,
  submit,
} from '@angular/forms/signals';
import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { fieldErrorMessage, focusFirstError } from '../../../shared/forms/form-errors';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { FormError } from '../../../shared/ui/form-error/form-error';
import { Select } from '../../../shared/ui/select/select';
import { TextField } from '../../../shared/ui/text-field/text-field';
import {
  WarehouseCounterpart,
  WarehouseRule,
  WarehouseRuleType,
  WarehouseSign,
} from './catalog.types';
import { editorErrors } from './catalog-errors';

/** Body of a warehouse rule write (creation: the whole rule; modification: what changed). */
export interface WarehouseRuleBody {
  type?: WarehouseRuleType;
  name?: string;
  quantity?: WarehouseSign;
  value?: WarehouseSign;
  counterpart?: WarehouseCounterpart;
  useLoadUnit?: boolean;
  cashLoad?: boolean;
  cashUnload?: boolean;
}

/** Dictionary names of the signs (`=` and the like cannot be part of a key). */
const SIGN_KEYS: Readonly<Record<WarehouseSign, string>> = {
  '=': 'KEEP',
  '+': 'ADD',
  '-': 'SUBTRACT',
};

/** Values of the selects of the form. */
export const WAREHOUSE_TYPES: readonly WarehouseRuleType[] = ['load', 'unload'];
export const WAREHOUSE_SIGNS: readonly WarehouseSign[] = ['=', '+', '-'];
export const WAREHOUSE_COUNTERPARTS: readonly WarehouseCounterpart[] = [
  'suppliers',
  'customers',
  'indoor',
];

/**
 * Form of a warehouse rule (causale). The type (load or unload) is chosen on creation and never
 * changes. The flags depend on it: only an unload can use the unit of the load or be the one the
 * cash register uses for sales; only a load can be the one used for returns. The server allows at
 * most one rule of the group with each cash-register flag (`taken`).
 */
@Component({
  selector: 'fc-warehouse-rule-editor',
  imports: [Button, Checkbox, FormError, FormField, Select, TextField, TPipe],
  templateUrl: './warehouse-rule-editor.html',
  styleUrl: './catalog-editor.css',
})
export class WarehouseRuleEditor {
  protected readonly i18n = inject(I18nService);

  /** The rule being changed; `null` to create one. */
  readonly item = input<WarehouseRule | null>(null);
  /** Error of the last save. */
  readonly error = input<ApiError | null>(null);
  /** A save is in progress. */
  readonly busy = input(false);
  /** The body to send. */
  readonly save = output<WarehouseRuleBody>();
  /** The user gave up. */
  readonly cancelled = output<void>();

  protected readonly model = linkedSignal(() => {
    const item = this.item();
    return {
      type: item?.type ?? 'load',
      name: item?.name ?? '',
      quantity: item?.quantity ?? '+',
      value: item?.value ?? '+',
      counterpart: item?.counterpart ?? 'suppliers',
      useLoadUnit: item?.useLoadUnit ?? false,
      cashLoad: item?.cashLoad ?? false,
      cashUnload: item?.cashUnload ?? false,
    };
  });
  protected readonly ruleForm = form(this.model, (path) => {
    required(path.name);
    maxLength(path.name, 100);
    disabled(path.type, () => this.item() !== null);
  });

  protected readonly isUnload = computed(() => this.model().type === 'unload');
  protected readonly typeOptions = computed(() =>
    WAREHOUSE_TYPES.map((value) => ({
      value,
      label: this.i18n.t(`CATALOG.WAREHOUSE_RULES.TYPE.${value.toUpperCase()}`),
    })),
  );
  protected readonly signOptions = computed(() =>
    WAREHOUSE_SIGNS.map((value) => ({
      value,
      label: this.i18n.t(`CATALOG.WAREHOUSE_RULES.SIGN.${SIGN_KEYS[value]}`),
    })),
  );
  protected readonly counterpartOptions = computed(() =>
    WAREHOUSE_COUNTERPARTS.map((value) => ({
      value,
      label: this.i18n.t(`CATALOG.WAREHOUSE_RULES.COUNTERPART.${value.toUpperCase()}`),
    })),
  );

  protected readonly errors = computed(() =>
    editorErrors(this.i18n, this.error(), [
      'type',
      'name',
      'quantity',
      'value',
      'counterpart',
      'useLoadUnit',
      'cashLoad',
      'cashUnload',
    ]),
  );

  /** Flags that apply to the chosen type (the others are never sent as `true`). */
  private flags(): Pick<WarehouseRuleBody, 'useLoadUnit' | 'cashLoad' | 'cashUnload'> {
    const model = this.model();
    return model.type === 'unload'
      ? { useLoadUnit: model.useLoadUnit, cashUnload: model.cashUnload }
      : { cashLoad: model.cashLoad };
  }

  protected readonly body = computed<WarehouseRuleBody>(() => {
    const model = this.model();
    const item = this.item();
    const flags = this.flags();
    if (item === null) {
      return {
        type: model.type,
        name: model.name.trim(),
        quantity: model.quantity,
        value: model.value,
        counterpart: model.counterpart,
        ...Object.fromEntries(Object.entries(flags).filter(([, on]) => on)),
      };
    }
    const body: WarehouseRuleBody = {};
    if (model.name.trim() !== item.name) {
      body.name = model.name.trim();
    }
    for (const key of ['quantity', 'value', 'counterpart'] as const) {
      if (model[key] !== item[key]) {
        Object.assign(body, { [key]: model[key] });
      }
    }
    for (const [key, on] of Object.entries(flags) as [keyof typeof flags, boolean][]) {
      if (on !== item[key]) {
        body[key] = on;
      }
    }
    return body;
  });
  protected readonly hasChanges = computed(
    () => this.item() === null || Object.keys(this.body()).length > 0,
  );

  protected message(field: ReadonlyFieldTree<unknown>, name: string): string | null {
    return fieldErrorMessage(this.i18n, field()) ?? this.errors().fields[name] ?? null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.ruleForm, {
      action: async () => {
        this.save.emit(this.body());
        return undefined;
      },
      onInvalid: () => focusFirstError(this.ruleForm),
    });
  }
}
