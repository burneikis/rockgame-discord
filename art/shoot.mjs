// Render the Discord activity art (art/art.html) to PNGs with Chrome on :9222.
// Needs the Vite dev server (npx vite) and Chrome (browser-tools/browser-start.js).
// usage: node art/shoot.mjs [cover|bg|icon ...]   (default: all three)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/.pi/agent/skills/browser-tools/package.json');
const puppeteer = require('puppeteer-core');

const SIZES = { cover: [1920, 1080, 'cover.png'], bg: [1920, 1080, 'background.png'], icon: [1024, 1024, 'icon.png'] };
const modes = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SIZES);
const base = process.env.ART_URL ?? 'http://localhost:5173/art/art.html';

const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
const p = await b.newPage();
await p.setCacheEnabled(false);
p.on('console', (m) => console.log(`  [${m.type()}] ${m.text()}`));
for (const m of modes) {
  const [w, h, file] = SIZES[m];
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await p.goto(`${base}?m=${m}`, { waitUntil: 'networkidle0' });
  await p.waitForFunction('window.__ready === true', { timeout: 30000 });
  const out = fileURLToPath(new URL(file, import.meta.url));
  await p.screenshot({ path: out });
  console.log(out);
}
await p.close();
await b.disconnect();
