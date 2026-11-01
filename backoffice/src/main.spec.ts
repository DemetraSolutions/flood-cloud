import { bootstrapApplication } from '@angular/platform-browser';

vi.mock('@angular/platform-browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@angular/platform-browser')>()),
  bootstrapApplication: vi.fn(),
}));

describe('main', () => {
  beforeEach(() => vi.resetModules());

  it('bootstraps the root component', async () => {
    vi.mocked(bootstrapApplication).mockResolvedValue(undefined as never);
    await import('./main');
    expect(bootstrapApplication).toHaveBeenCalledOnce();
  });

  it('logs a bootstrap failure instead of ignoring it', async () => {
    const failure = new Error('boom');
    vi.mocked(bootstrapApplication).mockRejectedValue(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('./main');
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure));
  });
});
