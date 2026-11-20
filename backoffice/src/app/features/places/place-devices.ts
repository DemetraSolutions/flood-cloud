import { Component, computed, inject, signal } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { withCurrent } from '../companies/company-options';
import { CredentialField } from './credential-field';
import { DeviceRow, newDevice, TerminalRow } from './place-model';

/** The form fields of a MultiSafepay terminal. */
type TerminalTree = { [K in keyof TerminalRow]: FieldTree<string> };
import { PlaceState } from './place-state';

/** The nine device types, in the order of the old form. */
export const DEVICE_TYPES = [
  'desk',
  'handheld',
  'ordering',
  'room-handheld',
  'selfordering',
  'waiting-list',
  'external-display',
  'kiosk',
  'tgm',
] as const;

/** Drivers of the fiscal printer. */
export const FISCAL_DRIVERS: readonly string[] = [
  'EPSON-FP-81-II-RT',
  'CUSTOM-K3-Q3X-KUBEX',
  'EPSON-EPOS-PRINT',
  'ESCPOS',
];

/** Drivers of the secondary printer. */
export const SECONDARY_DRIVERS: readonly string[] = ['EPSON-EPOS-PRINT', 'ESCPOS'];

/** Drivers of the automatic cash. */
export const AUTOMATIC_CASH_DRIVERS: readonly string[] = [
  'GLORY-CI5',
  'GLORY-CI10',
  'GLORY-CI10X',
  'CASHMATIC-SELFPAY-460',
  'CASHMATIC-SELFPAY-660',
  'CASHMATIC-SELFPAY-1060',
  'CASHLOGY-POS1500X',
  'VNE-AUTOMATIC-CASH',
  'CASH-SYSTEM',
  'CASHSPEED-SMARTTILL',
  'CASHDRO-7',
  'GLORY-CI5-XCASH',
  'GLORY-CI10-XCASH',
];

/** Most MultiSafepay terminals a device can have. */
export const MAX_TERMINALS = 20;

/** The blocks of the form of a device that only some types have. */
export type DeviceBlock =
  | 'fiscal'
  | 'secondary'
  | 'automaticCash'
  | 'pos'
  | 'externalDisplay'
  | 'companyPrinter'
  | 'favorites'
  | 'ordering'
  | 'scale';

/**
 * The device types each block is shown for (what a device of the other types has no use for is
 * hidden but keeps its values).
 */
export const BLOCK_TYPES: Readonly<Record<DeviceBlock, readonly string[]>> = {
  fiscal: ['desk', 'tgm'],
  secondary: ['desk'],
  automaticCash: ['desk', 'kiosk'],
  pos: ['desk', 'kiosk', 'selfordering'],
  externalDisplay: ['desk', 'kiosk'],
  companyPrinter: ['desk'],
  favorites: ['desk', 'handheld', 'ordering', 'room-handheld'],
  ordering: ['desk', 'handheld', 'ordering', 'room-handheld', 'selfordering', 'kiosk'],
  scale: ['desk'],
};

/**
 * Devices tab of the place: the devices of the POS (one is the server) with their printers,
 * automatic cash, POS terminals and print stations. Each device is a card with Modifica, Copia
 * and Elimina; changes are drafts of the unique save of the page.
 *
 * Texts built at run time: `PLACES.DEVICES.TYPE.DESK`, `.HANDHELD`, `.ORDERING`, `.ROOM_HANDHELD`,
 * `.SELFORDERING`, `.WAITING_LIST`, `.EXTERNAL_DISPLAY`, `.KIOSK`, `.TGM`; and the toggle
 * `PLACES.DEVICES.EDIT`, `.CLOSE`, `.SHOW`, `.HIDE` with their `_LABEL`.
 */
@Component({
  selector: 'fc-place-devices',
  imports: [Button, Checkbox, CredentialField, FormField, Select, StatusBadge, TextField, TPipe],
  templateUrl: './place-devices.html',
  styleUrl: './place-section.css',
})
export class PlaceDevices {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly items = this.state.form.devices.items;
  protected readonly devices = computed(() => this.state.model().devices);
  /** Whether the list can be changed: the user may write and the stored list is writable. */
  protected readonly editable = computed(() => this.devices().editable && this.state.canWrite());
  /** The device whose form is open (the one just added or copied, or the one being edited). */
  protected readonly opened = signal<number | null>(null);
  /** The print stations devices can be tied to: the saved ones (a new one has no id yet). */
  protected readonly stations = computed(() =>
    this.state.model().printStations.stations.filter((station) => station.id !== ''),
  );
  protected readonly favoriteOptions = computed<SelectOption[]>(() =>
    this.state.favorites().map((group) => ({ value: group.id, label: group.name })),
  );

  protected readonly maxTerminals = MAX_TERMINALS;
  protected readonly fiscalDrivers = FISCAL_DRIVERS;
  protected readonly secondaryDrivers = SECONDARY_DRIVERS;
  protected readonly cashDrivers = AUTOMATIC_CASH_DRIVERS;

  constructor() {
    this.state.need('favorites');
  }

  /** Whether a type may be chosen for the place: the legacy rules by plan, role and feature. */
  protected allowed(type: string): boolean {
    const plan = this.state.place()?.license.plan;
    if (
      type === 'tgm' &&
      !this.state.isPrivileged() &&
      !this.state.hasFeature('tobaccosGamesMonopoly')
    ) {
      return false;
    }
    if (type === 'desk' || plan === 'advanced') {
      return true;
    }
    return plan === 'basic' && ['waiting-list', 'external-display', 'kiosk', 'tgm'].includes(type);
  }

  /** The types to offer for a device: the allowed ones and the stored one. */
  protected typesFor(device: DeviceRow): string[] {
    const known = DEVICE_TYPES.filter((type) => this.allowed(type) || type === device.type);
    return (DEVICE_TYPES as readonly string[]).includes(device.type)
      ? known
      : [...known, device.type];
  }

  protected typeLabel(type: string): string {
    return (DEVICE_TYPES as readonly string[]).includes(type)
      ? this.i18n.t(`PLACES.DEVICES.TYPE.${type.toUpperCase().replace('-', '_')}`)
      : type;
  }

  /** Whether a block of the form is shown for a device. */
  protected shows(device: DeviceRow, block: DeviceBlock): boolean {
    return BLOCK_TYPES[block].includes(device.type);
  }

  /** The secondary company printer is only for platform administrators, dealers and tobacco groups. */
  protected readonly companyPrinterVisible = computed(
    () => this.state.isPrivileged() || this.state.hasFeature('tobaccosGamesMonopoly'),
  );

  protected driverOptions(drivers: readonly string[], current: string): SelectOption[] {
    return withCurrent(
      drivers.map((driver) => ({ value: driver, label: driver })),
      current,
      (value) => value,
    );
  }

  /** The devices of a type that can be linked from another device (saved ones only). */
  protected linkOptions(type: string, current: string, self: number): SelectOption[] {
    return withCurrent(
      this.devices()
        .items.filter((device, at) => at !== self && device.type === type && device.id !== '')
        .map((device) => ({ value: device.id, label: device.name || device.id })),
      current,
      (value) => value,
    );
  }

  protected favoritesOptions(current: string): SelectOption[] {
    return withCurrent(this.favoriteOptions(), current, (value) => value);
  }

  protected isOpen(index: number): boolean {
    return this.opened() === index || this.items[index]().invalid();
  }

  /** The key of the text of the toggle (`…_LABEL` is its accessible name): edit or just show. */
  protected toggleKeyOf(open: boolean): string {
    const key = this.editable() ? (open ? 'CLOSE' : 'EDIT') : open ? 'HIDE' : 'SHOW';
    return `PLACES.DEVICES.${key}`;
  }

  protected toggle(index: number): void {
    this.opened.update((current) => (current === index ? null : index));
  }

  /** The form fields of the MultiSafepay terminals of a device. */
  protected terminalsOf(index: number): readonly TerminalTree[] {
    return [...(this.items[index].multisafepayTerminals as unknown as Iterable<TerminalTree>)];
  }

  /** Label of a control of a terminal (the terminals of a device are numbered from 1). */
  protected terminalLabel(key: string, position: number): string {
    return this.i18n.t(`PLACES.DEVICES.${key}`, { number: position + 1 });
  }

  protected addTerminal(index: number): void {
    this.state.edit('devices', (block) => ({
      ...block,
      items: block.items.map((device, at) =>
        at === index
          ? {
              ...device,
              multisafepayTerminals: [
                ...device.multisafepayTerminals,
                { terminalId: '', name: '' },
              ],
            }
          : device,
      ),
    }));
  }

  protected removeTerminal(index: number, position: number): void {
    this.state.edit('devices', (block) => ({
      ...block,
      items: block.items.map((device, at) =>
        at === index
          ? {
              ...device,
              multisafepayTerminals: device.multisafepayTerminals.filter(
                (_, current) => current !== position,
              ),
            }
          : device,
      ),
    }));
  }

  protected hasStation(device: DeviceRow, id: string): boolean {
    return device.printStations.includes(id);
  }

  protected toggleStation(index: number, id: string, on: boolean): void {
    this.items[index]
      .printStations()
      .value.update((ids) =>
        on ? [...new Set([...ids, id])] : ids.filter((current) => current !== id),
      );
  }

  protected setType(index: number, type: string): void {
    this.items[index].type().value.set(type);
  }

  /** Only one device is the server: choosing one clears the others. */
  protected setServer(index: number, on: boolean): void {
    this.state.edit('devices', (block) => ({
      ...block,
      items: block.items.map((device, at) =>
        at === index ? { ...device, server: on } : on ? { ...device, server: false } : device,
      ),
    }));
  }

  protected add(): void {
    this.opened.set(this.devices().items.length);
    this.state.edit('devices', (block) => ({ ...block, items: [...block.items, newDevice()] }));
  }

  /** A copy of a device without its id, the server flag and its credentials (never readable). */
  protected copy(index: number): void {
    const source = this.devices().items[index];
    // A structured clone: a spread would also copy the symbol the form tracks a row by, and the
    // copy would then be taken for the original row.
    const copied: DeviceRow = {
      ...structuredClone(source),
      id: '',
      withoutId: false,
      server: false,
      name: this.i18n.t('PLACES.DEVICES.COPY_NAME', { name: source.name }),
      automaticCashUsername: { set: false, value: '', clear: false },
      automaticCashPassword: { set: false, value: '', clear: false },
    };
    this.opened.set(this.devices().items.length);
    this.state.edit('devices', (block) => ({ ...block, items: [...block.items, copied] }));
  }

  /**
   * Removes a device (the save asks the server, which refuses a busy one) and the links other
   * devices and the rooms had to it.
   */
  protected remove(index: number): void {
    const gone = this.devices().items[index].id;
    this.opened.update((current) =>
      current === null || current === index ? null : current > index ? current - 1 : current,
    );
    const unlink = (id: string): string => (id !== '' && id === gone ? '' : id);
    this.state.edit('devices', (block) => ({
      ...block,
      items: block.items
        .filter((_, at) => at !== index)
        .map((device) => ({
          ...device,
          externalDisplayId: unlink(device.externalDisplayId),
          secondaryCompanyPrinterId: unlink(device.secondaryCompanyPrinterId),
        })),
    }));
    this.state.edit('rooms', (block) => ({
      ...block,
      items: block.items.map((room) => ({ ...room, deviceId: unlink(room.deviceId) })),
    }));
  }
}
