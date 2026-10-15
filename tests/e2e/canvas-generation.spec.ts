import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = {
  keyPartners: 'Fixture partners',
  keyActivities: 'Fixture activities',
  valuePropositions: 'Fixture value proposition',
  customerRelationships: 'Fixture relationships',
  customerSegments: 'Fixture customers',
  keyResources: 'Fixture resources',
  channels: 'Fixture channels',
  costStructure: 'Fixture costs',
  revenueStreams: 'Fixture revenue',
};

/** Block titles that must appear in every Business Model Canvas export. */
const EXPECTED_CANVAS_LABELS = [
  'Key Partners',
  'Key Activities',
  'Value Propositions',
  'Customer Relationships',
  'Customer Segments',
  'Key Resources',
  'Channels',
  'Cost Structure',
  'Revenue Streams',
];

/**
 * Read the completed download from Playwright's temporary path and return
 * the raw bytes as a UTF-8 string.  The e2e runner controls the download
 * lifecycle, so this path is guaranteed to exist after `waitForEvent`.
 */
async function readDownloadedSvg(download: { path(): Promise<string | null> }): Promise<string> {
  const filePath = await download.path();
  if (!filePath) throw new Error('download path is unavailable');
  return readFileSync(filePath, 'utf-8');
}

async function fulfillSuccess(route: Route) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      kind: 'generate',
      result: { canvasData: fixture, analysisFeedback: { strengths: 'Coherent fixture', suggestions: 'Validate assumptions' } },
      receipt: { requestId: 'e2e', provider: 'fake', cached: false, durationMs: 1 },
    }),
  });
}

async function generate(page: Page) {
  await page.getByPlaceholder(/Describe your business idea/i).fill('A repair service for local businesses');
  await page.getByRole('button', { name: /^Generate Canvas$/i }).click();
  await expect(page.getByText('Fixture content for Value Propositions')).toBeVisible();
}

/** Open the export modal, click SVG, and resolve with the download object. */
async function exportSvg(page: Page) {
  await page.getByRole('button', { name: 'Export Canvas' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /^SVG/ }).click();
  return downloadPromise;
}

test.describe('strategy canvas core journey', () => {
  test('generates, keyboard-edits, exports a canvas, and the downloaded SVG bytes preserve the edit and labels', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Visual Strategy Canvas AI/i })).toBeVisible();
    await generate(page);

    const block = page.getByRole('button', { name: 'Edit Key Partners' });
    await block.focus();
    await page.keyboard.press('Enter');
    const editor = page.getByPlaceholder('Enter your content here...');
    await editor.fill('Edited partners');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Edited partners')).toBeVisible();

    const download = await exportSvg(page);
    expect(download.suggestedFilename()).toBe('Business_Model_Canvas.svg');

    // Inspect the actual downloaded bytes, not just the filename.
    const svgContent = await readDownloadedSvg(download);

    // 1. Valid SVG envelope (html-to-image emits an <svg> root element;
    //    the XML declaration is optional for downloaded SVG files).
    expect(svgContent).toContain('<svg');
    expect(svgContent).toContain('xmlns="http://www.w3.org/2000/svg"');

    // 2. The user-edited text survives export.
    expect(svgContent).toContain('Edited partners');

    // 3. Every expected Business Model Canvas block label is present.
    for (const label of EXPECTED_CANVAS_LABELS) {
      expect(svgContent, `expected label "${label}" in exported SVG`).toContain(label);
    }
  });

  test('exports user text containing markup-like characters as escaped text without executable script or event handlers', async ({ page }) => {
    await page.goto('/');
    await generate(page);

    // A fictional edit string that contains markup-like characters.
    // We expect the *literal text* to survive (escaped), but no actual
    // <script> element or on* event handler to appear in the SVG.
    const markupText = '<b>Bold</b> <script>alert(1)</script> onclick=evil()';

    const block = page.getByRole('button', { name: 'Edit Value Propositions' });
    await block.focus();
    await page.keyboard.press('Enter');
    const editor = page.getByPlaceholder('Enter your content here...');
    await editor.fill(markupText);
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Bold')).toBeVisible();

    const download = await exportSvg(page);
    expect(download.suggestedFilename()).toBe('Business_Model_Canvas.svg');
    const svgContent = await readDownloadedSvg(download);

    // The literal angle-bracket text must survive as escaped content,
    // proving the export does not silently drop user input.
    expect(svgContent).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');

    // Negative assertions: no executable script element and no inline
    // event-handler *attribute* (on*="..." or on*='...') in the exported
    // SVG.  We require quoted attribute values so that user-entered text
    // like "onclick=evil()" (which appears as escaped text content, not
    // as a tag attribute) does not trigger a false positive.
    expect(svgContent, 'exported SVG must not contain a <script> element').not.toMatch(/<script[\s>]/i);
    expect(svgContent, 'exported SVG must not contain an on* event-handler attribute').not.toMatch(/\son\w+\s*=\s*["'][^"']*["']/i);
  });

  test('cancels an in-flight generation without a fixed sleep', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/analysis', async (route) => { await gate; await fulfillSuccess(route); });
    await page.goto('/');
    await page.getByPlaceholder(/Describe your business idea/i).fill('A repair service');
    await page.getByRole('button', { name: /^Generate Canvas$/i }).click();
    await expect(page.getByRole('status')).toContainText('AI is thinking');
    await page.getByRole('button', { name: 'Cancel generation' }).click();
    release();
    await expect(page.getByRole('alert')).toContainText('Generation cancelled');
  });

  test('recovers from a provider failure', async ({ page }) => {
    let attempt = 0;
    await page.route('**/api/analysis', async (route) => {
      attempt += 1;
      if (attempt === 1) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ message: 'Strategy analysis is temporarily unavailable.' }) });
      return route.continue();
    });
    await page.goto('/');
    await page.getByPlaceholder(/Describe your business idea/i).fill('A repair service');
    await page.getByRole('button', { name: /^Generate Canvas$/i }).click();
    await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
    await page.getByRole('button', { name: /^Generate Canvas$/i }).click();
    await expect(page.getByText('Fixture content for Value Propositions')).toBeVisible();
  });

  test('keeps the core controls visible on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 851 });
    await page.goto('/');
    await expect(page.getByPlaceholder(/Describe your business idea/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Generate Canvas$/i })).toBeVisible();
  });
});
