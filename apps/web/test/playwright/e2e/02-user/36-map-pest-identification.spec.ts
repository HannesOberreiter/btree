import { expect, test } from '../../support/user-helpers';

test.describe('user - Pest map identification', () => {
  for (const [path, document] of [
    ['/map/vespa_velutina', /\/documents\/vespa_velutina_[a-z]{2}\.pdf$/],
    ['/map/aethina_tumida', /\/documents\/aethina_tumida_[a-z]{2}\.pdf$/]
  ] as const) {
    test(`${path} shows the identification PDF`, async ({ page, dataCy }) => {
      // The e2e build uses a dummy Matomo host, which script-src blocks.
      // Only frame-src matters for the PDF iframe.
      const cspViolations: string[] = [];
      page.on('console', message => {
        if (message.text().includes('directive: "frame-src')) {
          cspViolations.push(message.text());
        }
      });
      await page.route('**.tile.openstreetmap.org/**', route => route.abort());
      await page.goto(path);

      const pdfResponse = page.waitForResponse(response =>
        document.test(new URL(response.url()).pathname)
      );
      await dataCy('tab-identification').click();

      const response = await pdfResponse;
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('application/pdf');
      await expect(dataCy('pest-identification-document')).toHaveAttribute(
        'src',
        document
      );
      expect(cspViolations).toEqual([]);
    });
  }
});
