/**
 * Vendor Courier Prime (SIL OFL 1.1) from Google Fonts into public/fonts/.
 *
 * Plain Node ESM, run by hand; outputs are COMMITTED, never regenerated on
 * install/build/CI (the vendoring convention inherited from useful). It
 * downloads the four latin-subset woff2 faces, writes fonts.css with one
 * @font-face per face, and records bytes + SHA-256 in PROVENANCE.txt.
 *
 *   node tools/build-courier-prime.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');
const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400;1,700&display=swap';
// A modern-browser UA, or Google serves TTF instead of woff2.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const css = await fetch(CSS_URL, { headers: { 'user-agent': UA } }).then((r) => {
  if (!r.ok) throw new Error(`css fetch failed: ${r.status}`);
  return r.text();
});

const faces = [];
for (const block of css.split('@font-face').slice(1)) {
  const style = /font-style: (\w+)/.exec(block)?.[1];
  const weight = /font-weight: (\d+)/.exec(block)?.[1];
  const url = /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
  const range = /unicode-range: ([^;]+)/.exec(block)?.[1] ?? '';
  if (!style || !weight || !url) continue;
  if (!range.startsWith('U+0000-00FF')) continue; // latin subset only
  faces.push({ style, weight, url });
}
if (faces.length !== 4) throw new Error(`expected 4 latin faces, found ${faces.length}`);

mkdirSync(OUT, { recursive: true });
const provenance = [
  'Courier Prime — SIL Open Font License 1.1',
  'Source: Google Fonts (fonts.google.com/specimen/Courier+Prime), latin subset, v11',
  'Regenerate: node tools/build-courier-prime.mjs',
  '',
];
let fontsCss = '/* Courier Prime, vendored latin subset — see PROVENANCE.txt */\n';
for (const face of faces) {
  const name = `CourierPrime-${face.weight === '700' ? 'Bold' : 'Regular'}${face.style === 'italic' ? 'Italic' : ''}.woff2`;
  const bytes = Buffer.from(await (await fetch(face.url)).arrayBuffer());
  writeFileSync(join(OUT, name), bytes);
  provenance.push(`${name}  ${bytes.length} bytes  sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  fontsCss += `@font-face {\n  font-family: 'Courier Prime';\n  font-style: ${face.style};\n  font-weight: ${face.weight};\n  font-display: swap;\n  src: url('${name}') format('woff2');\n}\n`;
  console.log('vendored', name, bytes.length, 'bytes');
}
writeFileSync(join(OUT, 'fonts.css'), fontsCss);
writeFileSync(join(OUT, 'PROVENANCE.txt'), provenance.join('\n') + '\n');
console.log('done →', OUT);
