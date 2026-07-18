import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export type Screenshots = { desktop: string[]; mobile: string[] };

export const MAX_SEGMENTS = 8;

const VIEWPORTS = [
  { key: "desktop", width: 1440, height: 900 },
  { key: "mobile", width: 390, height: 844 },
] as const;

export async function screenshotPage(htmlPath: string, outDir: string, baseName = "candidate"): Promise<Screenshots> {
  const browser = await chromium.launch();
  try {
    const out: Record<string, string[]> = { desktop: [], mobile: [] };
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(500); // settle fonts/animations
      const scrollHeight: number = await page.evaluate(() => document.documentElement.scrollHeight);
      const segments = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(scrollHeight / vp.height)));
      for (let i = 0; i < segments; i++) {
        const y = Math.min(i * vp.height, Math.max(0, scrollHeight - vp.height)); // bottom-align last segment
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(150); // let scroll-triggered rendering settle
        const path = join(outDir, `${baseName}.${vp.key}.${i}.png`);
        await page.screenshot({ path }); // viewport-sized, NOT fullPage
        out[vp.key].push(path);
      }
      await page.close();
    }
    return { desktop: out.desktop, mobile: out.mobile };
  } finally {
    await browser.close();
  }
}
