import { Component, computed, inject } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { withCurrent } from '../companies/company-options';
import { newPrintStation, newProductionCenter, PrintStationRow } from './place-model';
import { PlaceState } from './place-state';

/** Drivers of a print station. */
export const STATION_DRIVERS: readonly string[] = ['EPSON-EPOS-PRINT', 'ESCPOS'];

/**
 * Print stations tab of the place: the printers that receive the orders (name, driver, host,
 * buzzer numbers, options and the summary of the other stations and of the product categories)
 * and the production centers (name and capacity). Each list has its own writable flag: a list
 * with an item the server cannot identify is shown read-only. Changes are drafts of the unique
 * save of the page.
 */
@Component({
  selector: 'fc-place-print-stations',
  imports: [Button, Checkbox, FormField, Select, TextField, TPipe],
  templateUrl: './place-print-stations.html',
  styleUrl: './place-section.css',
})
export class PlacePrintStations {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly stations = this.state.form.printStations.stations;
  protected readonly centers = this.state.form.printStations.productionCenters;
  protected readonly lists = computed(() => this.state.model().printStations);
  protected readonly stationsEditable = computed(
    () => this.lists().stationsEditable && this.state.canWrite(),
  );
  protected readonly centersEditable = computed(
    () => this.lists().productionCentersEditable && this.state.canWrite(),
  );

  constructor() {
    this.state.need('categories');
  }

  protected driverOptions(current: string): SelectOption[] {
    return withCurrent(
      STATION_DRIVERS.map((driver) => ({ value: driver, label: driver })),
      current,
      (value) => value,
    );
  }

  /** The other saved stations a summary can include (a new one has no id yet, never itself). */
  protected othersOf(index: number): { id: string; name: string }[] {
    return this.lists().stations.filter((station, at) => at !== index && station.id !== '');
  }

  protected has(ids: readonly string[], id: string): boolean {
    return ids.includes(id);
  }

  protected toggleSummaryStation(index: number, id: string, on: boolean): void {
    this.stations[index].summaryPrintStationsIds().value.update((ids) => this.toggled(ids, id, on));
  }

  protected toggleSummaryCategory(index: number, id: string, on: boolean): void {
    this.stations[index].summaryCategoriesIds().value.update((ids) => this.toggled(ids, id, on));
  }

  private toggled(ids: string[], id: string, on: boolean): string[] {
    return on
      ? [...ids.filter((current) => current !== id), id]
      : ids.filter((current) => current !== id);
  }

  protected stationName(station: PrintStationRow): string {
    return station.name === '' ? this.i18n.t('PLACES.STATIONS.NEW_STATION') : station.name;
  }

  protected addStation(): void {
    this.state.edit('printStations', (block) => ({
      ...block,
      stations: [...block.stations, newPrintStation()],
    }));
  }

  /**
   * Removes a station and what pointed to it: the summaries of the other stations, the stations
   * of the devices and of the rooms (a reference to a station that is gone is rejected by the server).
   */
  protected removeStation(index: number): void {
    const gone = this.lists().stations[index].id;
    const without = (ids: string[]): string[] => ids.filter((id) => gone === '' || id !== gone);
    this.state.edit('printStations', (block) => ({
      ...block,
      stations: block.stations
        .filter((_, at) => at !== index)
        .map((station) => ({
          ...station,
          summaryPrintStationsIds: without(station.summaryPrintStationsIds),
        })),
    }));
    this.state.edit('devices', (block) => ({
      ...block,
      items: block.items.map((device) => ({
        ...device,
        printStations: without(device.printStations),
      })),
    }));
    this.state.edit('rooms', (block) => ({
      ...block,
      items: block.items.map((room) => ({ ...room, printStations: without(room.printStations) })),
    }));
  }

  protected addCenter(): void {
    this.state.edit('printStations', (block) => ({
      ...block,
      productionCenters: [...block.productionCenters, newProductionCenter()],
    }));
  }

  protected removeCenter(index: number): void {
    this.state.edit('printStations', (block) => ({
      ...block,
      productionCenters: block.productionCenters.filter((_, at) => at !== index),
    }));
  }
}
