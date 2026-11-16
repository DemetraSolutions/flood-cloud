import { readFileSync } from 'node:fs';
import { TestBed } from '@angular/core/testing';
import { API, backend, provideApiTesting } from '../../../testing/api';
import { FEATURE_NAMES } from '../../core/groups/feature-catalog';
import { TEMPLATE_MODELS, TemplateModels } from './template-models';

const ASSETS = `${process.cwd()}/public/email-templates`;

beforeEach(() => TestBed.configureTestingModule({ providers: [...provideApiTesting()] }));
afterEach(() => backend().verify());

describe('template models', () => {
  it('offers the seven models of the legacy backoffice, the ones for tables and appointments behind their feature', () => {
    expect(TEMPLATE_MODELS.map((model) => [model.id, model.feature])).toEqual([
      ['advanced-report', null],
      ['table-reservation-notification', 'rooms'],
      ['table-reservation-received', 'rooms'],
      ['table-reservation-confirmed-status', 'rooms'],
      ['table-reservation-refused-status', 'rooms'],
      ['table-reservation-change-status', 'rooms'],
      ['appointment-confirmed', 'services'],
    ]);
    for (const model of TEMPLATE_MODELS) {
      expect(model.feature === null || FEATURE_NAMES.includes(model.feature)).toBe(true);
    }
  });

  it('keeps every model as two static files that the server accepts and that no longer point to the old backoffice', () => {
    for (const model of TEMPLATE_MODELS) {
      const html = readFileSync(`${ASSETS}/${model.id}.html`, 'utf8');
      const text = readFileSync(`${ASSETS}/${model.id}.txt`, 'utf8');
      expect(new TextEncoder().encode(html).length).toBeLessThan(256 * 1024);
      expect(new TextEncoder().encode(text).length).toBeLessThan(64 * 1024);
      expect(`${html}${text}`).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
      expect(html).not.toContain('backoffice.floodsoftware.cloud');
      expect(html).toContain('https://example.com/your-logo.png');
      expect(html).not.toMatch(/<script|<iframe|javascript:/i);
    }
  });

  it('reads the text and the HTML of a model from the same origin, as text', async () => {
    const reading = TestBed.inject(TemplateModels).content(TEMPLATE_MODELS[0]!);
    const text = backend().expectOne('/email-templates/advanced-report.txt');
    const html = backend().expectOne('/email-templates/advanced-report.html');
    expect(text.request.responseType).toBe('text');
    expect(text.request.url.startsWith(API)).toBe(false);
    text.flush('testo');
    html.flush('<p>html</p>');
    expect(await reading).toEqual({ text: 'testo', html: '<p>html</p>' });
  });
});
