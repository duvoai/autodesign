import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";

/** Freeze animations, transitions, and carets so screenshots are deterministic */
const FREEZE_CSS = `*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
}`;

export interface RenderResult {
  ok: boolean;
  desktopShot: string;
  mobileShot: string;
  fullShot: string;
  pageErrors: string[];
  mobileOverflow: boolean;
  visibleText: string;
  error?: string;
}

/** Serve a single HTML file on an ephemeral localhost port */
function serveHtml(htmlPath: string): Promise<{ url: string; close: () => void }> {
  const html = fs.readFileSync(htmlPath);

  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

/** Render a page's artifacts: above-the-fold desktop + mobile shots, full-page shot, page errors, visible text */
export async function render(htmlPath: string, outDir: string, browser?: Browser): Promise<RenderResult> {
  const ownBrowser = browser ?? (await chromium.launch());
  const { url, close } = await serveHtml(htmlPath);

  const desktopShot = path.join(outDir, "desktop.png");
  const mobileShot = path.join(outDir, "mobile.png");
  const fullShot = path.join(outDir, "full.png");
  const pageErrors: string[] = [];
  let mobileOverflow = false;
  let visibleText = "";

  try {
    // Desktop: above-the-fold + full-page + visible text
    const desktop = await ownBrowser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: true,
    });
    // Block everything that is not the page itself: generated pages must be self-contained
    await desktop.route("**/*", (route) =>
      route.request().url() === url ? route.continue() : route.abort(),
    );
    const dPage = await desktop.newPage();
    dPage.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
    await dPage.goto(url, { waitUntil: "load", timeout: 15000 });
    await dPage.addStyleTag({ content: FREEZE_CSS });
    await dPage.waitForTimeout(300);
    await dPage.screenshot({ path: desktopShot });
    await dPage.screenshot({ path: fullShot, fullPage: true });
    visibleText = await dPage.evaluate(() => document.body.innerText);
    await desktop.close();

    // Mobile: above-the-fold + overflow check
    const mobile = await ownBrowser.newContext({ viewport: { width: 390, height: 844 } });
    await mobile.route("**/*", (route) =>
      route.request().url() === url ? route.continue() : route.abort(),
    );
    const mPage = await mobile.newPage();
    mPage.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
    await mPage.goto(url, { waitUntil: "load", timeout: 15000 });
    await mPage.addStyleTag({ content: FREEZE_CSS });
    await mPage.waitForTimeout(300);
    await mPage.screenshot({ path: mobileShot });
    mobileOverflow = await mPage.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    await mobile.close();

    return { ok: true, desktopShot, mobileShot, fullShot, pageErrors, mobileOverflow, visibleText };
  } catch (e) {
    return {
      ok: false,
      desktopShot,
      mobileShot,
      fullShot,
      pageErrors,
      mobileOverflow,
      visibleText,
      error: String(e).slice(0, 300),
    };
  } finally {
    close();
    if (!browser) await ownBrowser.close();
  }
}

// CLI: tsx src/render.ts <path/to/index.html>
if (process.argv[1]?.endsWith("render.ts")) {
  const htmlPath = path.resolve(process.argv[2]);
  const res = await render(htmlPath, path.dirname(htmlPath));
  const { visibleText, ...rest } = res;
  console.log(JSON.stringify({ ...rest, visibleTextChars: visibleText.length }));
  process.exit(res.ok ? 0 : 1);
}
