import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, maxLength } from '@angular/forms/signals';
import { errorOf, findControl, typeInto } from '../../../testing/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { ContactEInvoicing } from './contact-e-invoicing';
import { EInvoicingModel, toModel } from './contact-model';

@Component({
  imports: [ContactEInvoicing],
  template: `<fc-contact-e-invoicing [form]="f" />`,
})
class Host {
  readonly model = signal<EInvoicingModel>(toModel(null).eInvoicing);
  readonly f = form(this.model, (path) => maxLength(path.pec, 5));
}

async function render() {
  TestBed.configureTestingModule({});
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key, params) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
  );
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const options = (label: string) =>
    [...(findControl(fixture, label) as HTMLSelectElement).options].map((option) =>
      option.textContent?.trim(),
    );
  return {
    fixture,
    host: fixture.componentInstance,
    root: fixture.nativeElement as HTMLElement,
    options,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('ContactEInvoicing', () => {
  it('starts with the default format and channel of the model', async () => {
    const { fixture, options } = await render();
    expect(findControl(fixture, 'CONTACTS.E_INVOICING.FORMAT').value).toBe('FPR12');
    expect(options('CONTACTS.E_INVOICING.FORMAT')).toEqual([
      'CONTACTS.E_INVOICING.FORMAT_FPR12',
      'CONTACTS.E_INVOICING.FORMAT_FPA12',
    ]);
    expect(findControl(fixture, 'CONTACTS.E_INVOICING.CHANNEL').value).toBe('CD');
    expect(options('CONTACTS.E_INVOICING.CHANNEL')).toEqual([
      'CONTACTS.E_INVOICING.CHANNEL_CD',
      'CONTACTS.E_INVOICING.CHANNEL_PEC',
    ]);
  });

  it('offers every payment term, method and tax regime with its code and its name', async () => {
    const { options } = await render();
    const terms = options('CONTACTS.E_INVOICING.PAYMENT_TERMS');
    expect(terms).toContain('CONTACTS.E_INVOICING.PAYMENT_TERM_NAME.TP01 (TP01)');
    expect(
      terms.filter(
        (text) => text?.endsWith('(TP01)') || text?.endsWith('(TP02)') || text?.endsWith('(TP03)'),
      ),
    ).toHaveLength(3);
    const methods = options('CONTACTS.E_INVOICING.PAYMENT_METHOD').filter((text) =>
      text?.includes('PAYMENT_METHOD_NAME'),
    );
    expect(methods).toHaveLength(23);
    expect(methods[22]).toBe('CONTACTS.E_INVOICING.PAYMENT_METHOD_NAME.MP23 (MP23)');
    const regimes = options('CONTACTS.E_INVOICING.TAX_REGIME').filter((text) =>
      text?.includes('TAX_REGIME_NAME'),
    );
    expect(regimes).toHaveLength(18);
    expect(regimes.join()).not.toContain('(RF03)');
  });

  it('explains the limit of the administration reference', async () => {
    const { root } = await render();
    expect(root.textContent).toContain(
      'CONTACTS.E_INVOICING.ADMINISTRATION_REFERENCE_HINT {"max":20}',
    );
  });

  it('writes the choices, the texts and the checkboxes of the user into the form', async () => {
    const { fixture, host } = await render();
    await typeInto(fixture, 'CONTACTS.E_INVOICING.FORMAT', 'FPA12');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.RECIPIENT_CODE', 'ABC1234');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.CHANNEL', 'PEC');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.PEC', 'a@pec.it');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.PAYMENT_TERMS', 'TP02');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.PAYMENT_METHOD', 'MP05');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.TAX_REGIME', 'RF01');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.ADMINISTRATION_REFERENCE', 'REF');
    findControl(fixture, 'CONTACTS.E_INVOICING.SPLIT_PAYMENT').click();
    findControl(fixture, 'CONTACTS.E_INVOICING.PURCHASE_ORDER').click();
    await fixture.whenStable();
    expect(host.model()).toMatchObject({
      transmissionFormat: 'FPA12',
      channel: 'PEC',
      recipientCode: 'ABC1234',
      pec: 'a@pec.it',
      paymentTerms: 'TP02',
      paymentMethod: 'MP05',
      taxRegime: 'RF01',
      administrationReference: 'REF',
      splitPayment: true,
      requirePurchaseOrderData: true,
    });
  });

  it('shows the error of a field once the user touched it', async () => {
    const { fixture } = await render();
    await typeInto(fixture, 'CONTACTS.E_INVOICING.CHANNEL', 'PEC');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.PEC', 'abcdefgh');
    expect(errorOf(fixture, 'CONTACTS.E_INVOICING.PEC')).toBe('');
    findControl(fixture, 'CONTACTS.E_INVOICING.PEC').dispatchEvent(new Event('blur'));
    await fixture.whenStable();
    expect(errorOf(fixture, 'CONTACTS.E_INVOICING.PEC')).not.toBe('');
  });

  it('asks for the recipient code with the CD channel and for the PEC with the PEC channel, keeping the other value', async () => {
    const { fixture, host, root } = await render();
    const labels = () =>
      [...root.querySelectorAll('label')].map((label) => label.textContent?.trim());
    expect(labels()).toContain('CONTACTS.E_INVOICING.RECIPIENT_CODE');
    expect(labels()).not.toContain('CONTACTS.E_INVOICING.PEC');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.RECIPIENT_CODE', 'ABC1234');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.CHANNEL', 'PEC');
    expect(labels()).toContain('CONTACTS.E_INVOICING.PEC');
    expect(labels()).not.toContain('CONTACTS.E_INVOICING.RECIPIENT_CODE');
    expect(host.model().recipientCode).toBe('ABC1234');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.PEC', 'a@pec.it');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.CHANNEL', 'CD');
    expect(host.model().pec).toBe('a@pec.it');
    expect(findControl(fixture, 'CONTACTS.E_INVOICING.RECIPIENT_CODE').value).toBe('ABC1234');
  });

  it('hints at the recipient code of the format that is chosen', async () => {
    const { fixture, root } = await render();
    expect(root.textContent).toContain('CONTACTS.E_INVOICING.RECIPIENT_CODE_HINT_FPR12');
    await typeInto(fixture, 'CONTACTS.E_INVOICING.FORMAT', 'FPA12');
    expect(root.textContent).toContain('CONTACTS.E_INVOICING.RECIPIENT_CODE_HINT_FPA12');
    expect(root.textContent).not.toContain('CONTACTS.E_INVOICING.RECIPIENT_CODE_HINT_FPR12');
  });

  it.each(['CD', 'PEC'])(
    'marks every control touched when it loses the focus (channel %s)',
    async (channel) => {
      const { fixture, root } = await render();
      await typeInto(fixture, 'CONTACTS.E_INVOICING.CHANNEL', channel);
      const controls = root.querySelectorAll('input, select');
      expect(controls.length).toBeGreaterThan(6);
      controls.forEach((control) => control.dispatchEvent(new Event('blur')));
      await fixture.whenStable();
      expect(root.querySelectorAll('input, select').length).toBe(controls.length);
    },
  );
});
