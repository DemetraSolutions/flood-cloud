import { renderPlace } from '../../../testing/places';
import {
  cleanUp,
  failPut,
  isChecked,
  READ_ONLY,
  savePut,
  storedBlock,
  submitTab,
  withValue,
} from '../../../testing/places-tabs';
import { MAX_IMPORT_BYTES } from './printing-transfer';

const f = (key: string) => `PLACES.F.PRINTING.${key}`;
const G = (key: string) => `PLACES.G.PRINTING.${key}`;
const P = (key: string) => `PLACES.PRINTING.${key}`;
const CA = { role: 'CA', groupId: '665f1c2e9b1d4a0012ab34a1' } as const;

afterEach(() => {
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  cleanUp();
});

/** The text of a blob (jsdom has no `Blob.text()`). */
function readText(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsText(blob);
  });
}

/** Chooses a file in the import input, as the file chooser does, and lets the page read it. */
async function importFile(
  view: Awaited<ReturnType<typeof renderPlace>>,
  content: string,
  size?: number,
) {
  const input = view.root.querySelector<HTMLInputElement>('input[type=file]') as HTMLInputElement;
  const file = new File([content], 'printing.json', { type: 'application/json' });
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { value: size });
  }
  const resets: string[] = [];
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => 'C:\\fakepath\\printing.json',
    set: (value: string) => resets.push(value),
  });
  input.dispatchEvent(new Event('change'));
  await view.view();
  return resets;
}

describe('PlacePrinting', () => {
  it('shows the stored data', async () => {
    const view = await renderPlace({ path: 'printing' });
    expect(isChecked(view, f('RECEIPT.USER'))).toBe(false);
    expect(view.control(f('RECEIPT.SUBTOTAL_FONT_SIZE')).value).toBe('1-1');
    expect(view.control(f('RECEIPT.INVOICE_QT')).value).toBe('1');
    expect(view.text()).toContain(G('RECEIPT_OPTIONS'));
    expect(view.text()).toContain(G('PREBILLING_OPTIONS'));
    expect(view.text()).toContain(G('ORDERING_FONTS'));
  });

  it('saves the whole block with the exact PUT', async () => {
    const view = await renderPlace({ path: 'printing' });
    await view.toggle(f('RECEIPT.USER'), true);
    await view.type(f('RECEIPT.SUBTOTAL_FONT_SIZE'), '2-3');
    await view.type(f('RECEIPT.INVOICE_QT'), '3');
    await view.type(f('RECEIPT.NO_FISCAL_BOTTOM_TEXT'), 'Grazie');
    await view.toggle(f('PREBILLING.HEADER'), true);
    await view.type(f('ORDERING.PRODUCTS_SORTING'), 'alphabetical');
    await view.type(f('ORDERING.TABLE_TEXT'), 'Tavolo');
    let block = withValue(storedBlock('printing'), 'receipt.user', true);
    block = withValue(block, 'receipt.subtotalFontSize', '2-3');
    block = withValue(block, 'receipt.invoiceQt', 3);
    block = withValue(block, 'receipt.noFiscalBottomText', 'Grazie');
    block = withValue(block, 'prebilling.header', true);
    block = withValue(block, 'ordering.productsSorting', 'alphabetical');
    block = withValue(block, 'ordering.tableText', 'Tavolo');
    await savePut(view, 'settings/printing', block);
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('offers the font sizes without an empty choice', async () => {
    const view = await renderPlace({ path: 'printing' });
    const options = [...view.control(f('RECEIPT.SUBTOTAL_FONT_SIZE')).querySelectorAll('option')];
    expect(options).toHaveLength(9);
    expect(options[1].textContent?.trim()).toBe('1 × 2');
  });

  it('hides the pre-bill and order groups without the ordering feature and keeps their values', async () => {
    const view = await renderPlace({ path: 'printing', features: ['rooms'] });
    expect(view.text()).toContain(G('RECEIPT_OPTIONS'));
    expect(view.text()).toContain(f('RECEIPT.SEATS_TOP'));
    expect(view.text()).not.toContain(G('PREBILLING_OPTIONS'));
    expect(view.text()).not.toContain(G('ORDERING_GENERAL'));
    await view.toggle(f('RECEIPT.USER'), true);
    await savePut(
      view,
      'settings/printing',
      withValue(storedBlock('printing'), 'receipt.user', true),
    );
  });

  it('hides the keys of the rooms module without the feature', async () => {
    const view = await renderPlace({ path: 'printing', features: [] });
    expect(view.text()).not.toContain(f('RECEIPT.SEATS_TOP'));
    expect(view.text()).toContain(f('RECEIPT.USER'));
  });

  it('puts the 422 on the control of a nested key', async () => {
    const view = await renderPlace({ path: 'printing' });
    await view.toggle(f('RECEIPT.USER'), true);
    await failPut(view, 'settings/printing', [
      { field: 'printing.receipt.invoiceQt', issue: 'incorrect' },
      { field: 'printing.ordering.tableText', issue: 'incorrect' },
    ]);
    expect(view.error(f('RECEIPT.INVOICE_QT'))).toContain('FORM.ISSUE.INCORRECT');
    expect(view.error(f('ORDERING.TABLE_TEXT'))).toContain('FORM.ISSUE.INCORRECT');
  });

  it('ignores the submit of the form and marks the fields as touched', async () => {
    const view = await renderPlace({ path: 'printing' });
    await submitTab(view);
    await view.blurAll();
  });

  describe('export', () => {
    it('downloads the configuration as a JSON file', async () => {
      const blobs: Blob[] = [];
      const create = vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:printing';
      });
      const revoke = vi.fn();
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
      const clicks: { download: string; href: string }[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicks.push({ download: this.download, href: this.href });
      });
      const view = await renderPlace({ path: 'printing' });
      await view.toggle(f('RECEIPT.USER'), true);
      await view.click(P('EXPORT'));
      expect(clicks).toEqual([{ download: 'printing.json', href: 'blob:printing' }]);
      expect(revoke).toHaveBeenCalledWith('blob:printing');
      expect(blobs[0].type).toBe('application/json');
      const content = JSON.parse(await readText(blobs[0]));
      expect(content).toEqual(withValue(storedBlock('printing'), 'receipt.user', true));
      expect(Object.keys(content)).toEqual(['receipt', 'prebilling', 'ordering']);
    });
  });

  describe('import', () => {
    it('applies the valid keys, counts the ignored ones and resets the input', async () => {
      const view = await renderPlace({ path: 'printing' });
      const resets = await importFile(
        view,
        JSON.stringify({
          receipt: {
            user: true,
            note: 'not a flag',
            invoiceQt: 4,
            subtotalFontSize: '3-3',
            noFiscalBottomText: null,
            unknown: true,
          },
          prebilling: { header: true },
          other: 1,
        }),
      );
      expect(resets).toEqual(['']);
      expect(view.toasts()).toEqual(['PLACES.PRINTING.IMPORTED {"applied":5,"ignored":1}']);
      expect(isChecked(view, f('RECEIPT.USER'))).toBe(true);
      expect(isChecked(view, f('RECEIPT.NOTE'))).toBe(false);
      expect(view.control(f('RECEIPT.INVOICE_QT')).value).toBe('4');
      expect(view.control(f('RECEIPT.SUBTOTAL_FONT_SIZE')).value).toBe('3-3');
      let block = withValue(storedBlock('printing'), 'receipt.user', true);
      block = withValue(block, 'receipt.invoiceQt', 4);
      block = withValue(block, 'receipt.subtotalFontSize', '3-3');
      block = withValue(block, 'prebilling.header', true);
      await savePut(view, 'settings/printing', block);
    });

    it('refuses a file that is too large', async () => {
      const view = await renderPlace({ path: 'printing' });
      const resets = await importFile(view, '{}', MAX_IMPORT_BYTES + 1);
      expect(resets).toEqual(['']);
      expect(view.toasts()).toEqual(['PLACES.PRINTING.IMPORT_TOO_LARGE']);
    });

    it.each(['not json', '[1, 2]', 'null', '"text"'])(
      'refuses a file that is not a JSON object (%s)',
      async (content) => {
        const view = await renderPlace({ path: 'printing' });
        await importFile(view, content);
        expect(view.toasts()).toEqual(['PLACES.PRINTING.IMPORT_INVALID']);
        expect(isChecked(view, f('RECEIPT.USER'))).toBe(false);
      },
    );

    it('accepts an empty object and applies nothing', async () => {
      const view = await renderPlace({ path: 'printing' });
      await importFile(view, '{}');
      expect(view.toasts()).toEqual(['PLACES.PRINTING.IMPORTED {"applied":0,"ignored":0}']);
    });
  });

  describe('transfer', () => {
    it.each(['PSA', 'D'] as const)('is available to a %s', async (role) => {
      const view = await renderPlace({ path: 'printing', profile: { role } });
      expect(view.text()).toContain(P('TRANSFER'));
      expect(view.button(P('EXPORT'))).toBeDefined();
      expect(view.root.querySelector('input[type=file]')).not.toBeNull();
    });

    it('is not available to a company administrator', async () => {
      const view = await renderPlace({ path: 'printing', profile: CA });
      expect(view.text()).not.toContain(P('TRANSFER'));
      expect(view.button(P('EXPORT'))).toBeUndefined();
      expect(view.root.querySelector('input[type=file]')).toBeNull();
    });

    it('lets a read-only administrator export but not import', async () => {
      const view = await renderPlace({ path: 'printing', permissions: READ_ONLY });
      expect(view.button(P('EXPORT'))).toBeDefined();
      expect(view.root.querySelector('input[type=file]')).toBeNull();
      expect(view.control(f('RECEIPT.USER')).disabled).toBe(true);
      expect(view.button('COMMON.SAVE')).toBeUndefined();
    });
  });
});
