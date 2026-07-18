import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenshotPage, MAX_SEGMENTS } from "../src/inner/screenshot";

test("long page yields multiple scroll segments per viewport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shot-"));
  const html = join(dir, "output.html");
  // ~4 desktop screens tall
  writeFileSync(html, `<html><body style="margin:0"><div style="height:3600px;background:linear-gradient(#0a5,#a05)"><h1>Hello</h1></div></body></html>`);
  const shots = await screenshotPage(html, dir);
  expect(shots.desktop.length).toBeGreaterThanOrEqual(3);
  expect(shots.desktop.length).toBeLessThanOrEqual(MAX_SEGMENTS);
  expect(shots.mobile.length).toBeGreaterThanOrEqual(4);
  expect(shots.desktop[0]).toContain("candidate.desktop.0.png");
  for (const p of [...shots.desktop, ...shots.mobile]) expect(statSync(p).size).toBeGreaterThan(1000);
}, 60000);

test("short page yields exactly one segment per viewport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shot2-"));
  const html = join(dir, "output.html");
  writeFileSync(html, `<html><body><h1>Tiny</h1></body></html>`);
  const shots = await screenshotPage(html, dir);
  expect(shots.desktop.length).toBe(1);
  expect(shots.mobile.length).toBe(1);
}, 60000);
