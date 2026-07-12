#!/usr/bin/env node
// Renders the README hero banner ENTIRELY from code — a synthetic
// "Notion window → one import → Hanji window" composition drawn with
// HTML/CSS (same idea as the ImportDialog's code-drawn token walkthrough
// mockups; no real app, no Notion assets, generic UI only).
//   output: assets/brand/notion-to-hanji-banner.png (2x)
// Rerun after design changes: node scripts/readme-hero-banner.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright, resolveChromeExecutable } from './lib/harness.mjs';

const OUT = new URL('../assets/brand/notion-to-hanji-banner.png', import.meta.url).pathname;

const HTML = /* html */ `<!doctype html>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 860px; height: 828px; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: linear-gradient(180deg, #faf8f4 0%, #f3efe7 100%);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
    color: #37352f;
  }
  .window {
    width: 700px; height: 300px; border-radius: 10px; overflow: hidden;
    background: #fff; box-shadow: 0 18px 40px rgba(55, 53, 47, 0.16), 0 2px 6px rgba(55, 53, 47, 0.08);
    display: flex; flex-direction: column;
  }
  .titlebar {
    height: 34px; flex: none; display: flex; align-items: center; gap: 8px;
    padding: 0 12px; border-bottom: 1px solid #ececea; background: #fbfbfa;
    font-size: 12px; color: #9b9891; font-weight: 500;
  }
  .dots { display: flex; gap: 6px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .titlebar .label { flex: 1; text-align: center; margin-right: 46px; }
  .app { flex: 1; display: flex; min-height: 0; }
  .side {
    width: 128px; flex: none; background: #f7f6f3; border-right: 1px solid #ececea;
    padding: 10px 8px; font-size: 11px; color: #6f6d66; line-height: 2.1;
  }
  .side div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .side .ws { font-weight: 600; color: #37352f; margin-bottom: 6px; font-size: 11.5px; }
  .main { flex: 1; padding: 20px 24px; min-width: 0; }
  .pageTitle { font-size: 19px; font-weight: 700; letter-spacing: -0.2px; margin: 6px 0 12px; }
  .row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: #55534c; margin: 7px 0; }
  .cb { width: 12px; height: 12px; border: 1.4px solid #b9b6ae; border-radius: 3px; flex: none; }
  .cb.done { background: #2383e2; border-color: #2383e2; position: relative; }
  .cb.done::after { content: ""; position: absolute; left: 3.2px; top: 0.6px; width: 3px; height: 7px;
    border: solid #fff; border-width: 0 1.6px 1.6px 0; transform: rotate(45deg); }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 11px; color: #55534c; }
  th, td { border-bottom: 1px solid #efeeec; text-align: left; padding: 5px 6px; font-weight: 400; }
  th { color: #9b9891; font-size: 10px; border-bottom: 1px solid #e3e2de; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 10px; }
  .t1 { background: #dbeddb; color: #1c3829; } .t2 { background: #fadec9; color: #49290e; }
  .mid { display: flex; flex-direction: column; align-items: center; gap: 7px; flex: none; }
  .arrow { font-size: 40px; color: #37352f; line-height: 1; }
  .sub { white-space: nowrap; }
  .pill {
    padding: 5px 13px; border-radius: 999px; background: #37352f; color: #fff;
    font-size: 12px; font-weight: 600; letter-spacing: 0.2px; white-space: nowrap;
  }
  .sub { font-size: 11px; color: #85827a; text-align: center; line-height: 1.45; }
  .hanji .titlebar { background: #fbfaf7; }
  .hanji .side { background: #f8f6f1; }
  .wave { font-size: 34px; margin-bottom: 4px; }
  .muted { color: #9b9891; }
  .brandRow { display: flex; align-items: center; gap: 6px; }
  .seal { width: 14px; height: 14px; border-radius: 3px; background: #37352f; color: #f3efe7;
    font-size: 9px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
</style>
<body>
  <div class="window">
    <div class="titlebar">
      <div class="dots"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span></div>
      <div class="label">Notion · My Workspace</div>
    </div>
    <div class="app">
      <div class="side">
        <div class="ws">◧ My Workspace</div>
        <div>▸ 📋 Product roadmap</div>
        <div>▸ 🗂 Client tracker</div>
        <div>▸ 📝 Meeting notes</div>
        <div>▸ 📚 Team wiki</div>
      </div>
      <div class="main">
        <div class="pageTitle">📋 Product roadmap</div>
        <div class="row"><span class="cb done"></span> Ship the beta</div>
        <div class="row"><span class="cb"></span> Collect feedback</div>
        <table>
          <tr><th>Task</th><th>Owner</th><th>Status</th></tr>
          <tr><td>Landing page</td><td>Kim</td><td><span class="tag t1">Done</span></td></tr>
          <tr><td>Pricing draft</td><td>Lee</td><td><span class="tag t2">Doing</span></td></tr>
        </table>
      </div>
    </div>
  </div>

  <div class="mid">
    <div class="arrow">↓</div>
    <div class="pill">one import</div>
    <div class="sub">pages · databases · relations · views · files · comments</div>
  </div>

  <div class="window hanji">
    <div class="titlebar">
      <div class="dots"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span></div>
      <div class="label">Hanji · your own server</div>
    </div>
    <div class="app">
      <div class="side">
        <div class="ws brandRow"><span class="seal">한</span> Hanji</div>
        <div>▸ 📋 Product roadmap</div>
        <div>▸ 🗂 Client tracker</div>
        <div>▸ 📝 Meeting notes</div>
        <div>▸ 📚 Team wiki</div>
      </div>
      <div class="main">
        <div class="pageTitle">📋 Product roadmap</div>
        <div class="row"><span class="cb done"></span> Ship the beta</div>
        <div class="row"><span class="cb"></span> Collect feedback</div>
        <table>
          <tr><th>Task</th><th>Owner</th><th>Status</th></tr>
          <tr><td>Landing page</td><td>Kim</td><td><span class="tag t1">Done</span></td></tr>
          <tr><td>Pricing draft</td><td>Lee</td><td><span class="tag t2">Doing</span></td></tr>
        </table>
      </div>
    </div>
  </div>
</body>`;

const htmlPath = join(tmpdir(), `hanji-banner-${Date.now()}.html`);
writeFileSync(htmlPath, HTML);
mkdirSync(new URL('../assets/brand/', import.meta.url).pathname, { recursive: true });

const { chromium } = await loadPlaywright({ label: 'readme hero banner' });
const browser = await chromium.launch({ executablePath: resolveChromeExecutable() });
try {
  const page = await browser.newPage({ viewport: { width: 860, height: 828 }, deviceScaleFactor: 2 });
  await page.goto(`file://${htmlPath}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT });
  console.log(`saved ${OUT}`);
} finally {
  await browser.close();
}
console.log('PASS README hero banner rendered from code.');
