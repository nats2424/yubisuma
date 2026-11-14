// OGP 画像を撮る。使い方：NODE_PATH=$(npm root -g) node design/ogp/render.mjs
// Playwright と Chromium が入っている前提（playwright install はしない）。CHROME_PATH で実行ファイルを指定できる
// 1200×630・deviceScaleFactor 1 で ogp.png を、中央 630×630 を切った確認用 ogp-square-check.png を出す
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ESM の import は NODE_PATH を見ないので、グローバルの playwright を require で読む
const { chromium } = createRequire(import.meta.url)('playwright');

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto('file://' + path.join(dir, 'ogp.html'), { waitUntil: 'networkidle' });
// Google Fonts の読み込みを待つ（待たないと代替フォントで撮れてしまう）
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(dir, 'ogp.png'), clip: { x: 0, y: 0, width: 1200, height: 630 } });
await page.screenshot({ path: path.join(dir, 'ogp-square-check.png'), clip: { x: 285, y: 0, width: 630, height: 630 } });
await browser.close();
