// 作り手のアイコンのラフを撮る。使い方：NODE_PATH=$(npm root -g) node design/brand/render.mjs
// Playwright と Chromium が入っている前提（playwright install はしない）。CHROME_PATH で実行ファイルを指定できる
// card-*.png：5 秒テスト用の正方形カード（1080×1080）。sizes-check.png：16〜96px・ライト/ダークでの見え方
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(dir, 'icon-roughs.html'), { waitUntil: 'networkidle' });
// Google Fonts の読み込みを待つ（待たないと代替フォントで撮れてしまう）
await page.evaluate(() => document.fonts.ready);
for (const id of ['niyari', 'watto', 'wacha']) {
  await page.locator('#card-' + id).screenshot({ path: path.join(dir, `card-${id}.png`) });
}
await page.locator('#sheet').screenshot({ path: path.join(dir, 'sizes-check.png') });
await browser.close();
