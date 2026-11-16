import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { newStorage } from './place-model';
import { PlaceState } from './place-state';

/**
 * Storages tab of the place: the warehouses with their name and the two flags that choose which
 * one the cash and the e-commerce use. The rules of the old backoffice: at least one storage,
 * exactly one for the cash (so the chosen one cannot be unticked, ticking another moves it) and
 * at most one for the e-commerce (ticking one clears the others). The server checks them again
 * and reports a violation on the list.
 */
@Component({
  selector: 'fc-place-storages',
  imports: [Button, Checkbox, FormField, TextField, TPipe],
  templateUrl: './place-storages.html',
  styleUrl: './place-section.css',
})
export class PlaceStorages {
  protected readonly state = inject(PlaceState);

  protected readonly items = this.state.form.storages.items;
  protected readonly storages = computed(() => this.state.model().storages);
  /** Whether the list can be changed: the user may write and the stored list is writable. */
  protected readonly editable = computed(() => this.storages().editable && this.state.canWrite());
  protected readonly showCash = computed(
    () => this.state.isPrivileged() || this.state.hasFeature('cash'),
  );
  protected readonly showEcommerce = computed(
    () => this.state.isPrivileged() || this.state.hasFeature('customersApp'),
  );

  /** Ticks a flag on one storage and clears it on the others. */
  protected choose(index: number, flag: 'cash' | 'ecommerce'): void {
    this.state.edit('storages', (block) => ({
      ...block,
      items: block.items.map((storage, at) => ({ ...storage, [flag]: at === index })),
    }));
  }

  protected setEcommerce(index: number, on: boolean): void {
    if (on) {
      this.choose(index, 'ecommerce');
    } else {
      this.items[index].ecommerce().value.set(false);
    }
  }

  protected add(): void {
    this.state.edit('storages', (block) => ({ ...block, items: [...block.items, newStorage()] }));
  }

  protected remove(index: number): void {
    this.state.edit('storages', (block) => ({
      ...block,
      items: block.items.filter((_, at) => at !== index),
    }));
  }
}
