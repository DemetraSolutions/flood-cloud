import type { ReferenceKind } from '../../core/reference/reference-store';

/** The XLSX tools of the backoffice: the catalog (C6), the contacts and the advanced loyalty cards (K3). */
export const XLSX_TOOL_KEYS = ['catalog', 'contacts', 'cards'] as const;

/** A tool of {@link XLSX_TOOL_KEYS}. */
export type XlsxToolKey = (typeof XLSX_TOOL_KEYS)[number];

/** What differs from one XLSX tool to another; the page, the API and the texts common to all of them are shared. */
export interface XlsxTool {
  /** Dictionary prefix of the texts of the tool (title, hint, rules, limits…); the texts common to all the tools stay under `CATALOG_XLSX`. */
  readonly prefix: string;
  /** Last segment of the route of the page (`/groups/:groupId/tools/<route>`). */
  readonly route: string;
  /** Base of the URLs of the model and of the export (`/v1/groups/{groupId}/<exportPath>`). */
  readonly exportPath: string;
  /** URL of the import (`/v1/groups/{groupId}/<importPath>`). */
  readonly importPath: string;
  /** Start of the names of the files the page saves. */
  readonly fileBase: string;
  /** Permission that shows the import part of the page (the model and the export need the one of the page). */
  readonly importPermission: string;
  /** The sheets of the workbook, as the keys of `sheets` in the answer of the import (their texts are `<prefix>.SHEET.<KEY>`). */
  readonly sheets: readonly string[];
  /** The paragraphs of the rules of the file (`<prefix>.RULES.<KEY>`). */
  readonly rules: readonly string[];
  /** Whether the model has columns that depend on the points of sale of the user (the note is `<prefix>.TEMPLATE.PLACES_NOTE`). */
  readonly placesNote: boolean;
  /** Whether the file can remove entries (the cards never: `removed` is always 0, so the counts leave it out). */
  readonly showsRemoved: boolean;
  /** The lists of the reference store that an import makes stale. */
  readonly invalidates: readonly ReferenceKind[];
}

/** The tools, by key. */
export const XLSX_TOOLS: Readonly<Record<XlsxToolKey, XlsxTool>> = {
  catalog: {
    prefix: 'CATALOG_XLSX',
    route: 'catalog-import-export',
    exportPath: 'catalog-export',
    importPath: 'catalog-import',
    fileBase: 'catalog',
    importPermission: 'products:update',
    sheets: ['products', 'variants', 'categories'],
    rules: ['SHEETS', 'ID', 'DELETE', 'ABSENT_COLUMN', 'PLACES', 'NOT_IN_FILE'],
    placesNote: true,
    showsRemoved: true,
    invalidates: ['product-categories', 'products'],
  },
  contacts: {
    prefix: 'CONTACTS_XLSX',
    route: 'contacts-import-export',
    exportPath: 'contacts-export',
    importPath: 'contacts-import',
    fileBase: 'contacts',
    importPermission: 'contacts:import',
    sheets: ['contacts'],
    rules: [
      'SHEET',
      'ID',
      'DELETE',
      'ABSENT_COLUMN',
      'COMPANY_BLOCK',
      'LISTS',
      'FIDELITY',
      'NOT_IN_FILE',
    ],
    placesNote: false,
    showsRemoved: true,
    invalidates: ['customers', 'suppliers'],
  },
  cards: {
    prefix: 'CARDS_XLSX',
    route: 'fidelity-cards-import-export',
    exportPath: 'fidelity-cards-export',
    importPath: 'fidelity-cards-import',
    fileBase: 'fidelity-cards',
    importPermission: 'fidelityCards:import',
    sheets: ['cards'],
    rules: ['SHEET', 'KEY', 'NEW', 'EXISTING', 'STATUS', 'NOT_IN_FILE'],
    placesNote: false,
    showsRemoved: false,
    invalidates: [],
  },
};

/**
 * Router link of the page of a tool of the group.
 *
 * @param tool The tool.
 * @param groupId The group.
 */
export function xlsxToolRoute(tool: XlsxToolKey, groupId: string): string[] {
  return ['/groups', groupId, 'tools', XLSX_TOOLS[tool].route];
}
