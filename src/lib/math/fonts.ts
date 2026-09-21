/**
 * The vendored MathLive stylesheets, and the KaTeX faces it draws with.
 *
 * Namespaced `math/` rather than after any one feature: the formula editor
 * and a note being read share this one bundle rather than vendoring two
 * copies of the same twenty files.
 *
 * `mathlive-fonts.css` is the whole font mechanism. Its last rule is
 * `:root{--ML__static-fonts:true}`, which tells MathLive's own font loader to
 * stand down — so the library constructs no `FontFace`, probes for no fonts
 * directory, and the browser pulls each face on demand through
 * `font-display: swap`. Measured on a production build: **two** faces fetched
 * for a typical formula and zero `HEAD` requests, against all twenty fetched
 * eagerly plus a stray `HEAD` when `MathfieldElement.fontsDirectory` is used
 * instead.
 *
 * `mathlive-static.css` is the layout half — what turns the markup
 * `convertLatexToMarkup` returns into a typeset formula. An open
 * `<math-field>` injects its own copy of those rules, so this file is what a
 * page with no editor on it (a note being read, the HTML export) needs.
 *
 * Regenerate both with `node tools/build-math-assets.mjs --force`.
 */
import { href } from '../paths';

/** The twenty faces, as `public/math/PROVENANCE.txt` records them. */
export const MATH_FONT_FILES: readonly string[] = [
  'KaTeX_AMS-Regular.woff2',
  'KaTeX_Caligraphic-Bold.woff2',
  'KaTeX_Caligraphic-Regular.woff2',
  'KaTeX_Fraktur-Bold.woff2',
  'KaTeX_Fraktur-Regular.woff2',
  'KaTeX_Main-Bold.woff2',
  'KaTeX_Main-BoldItalic.woff2',
  'KaTeX_Main-Italic.woff2',
  'KaTeX_Main-Regular.woff2',
  'KaTeX_Math-BoldItalic.woff2',
  'KaTeX_Math-Italic.woff2',
  'KaTeX_SansSerif-Bold.woff2',
  'KaTeX_SansSerif-Italic.woff2',
  'KaTeX_SansSerif-Regular.woff2',
  'KaTeX_Script-Regular.woff2',
  'KaTeX_Size1-Regular.woff2',
  'KaTeX_Size2-Regular.woff2',
  'KaTeX_Size3-Regular.woff2',
  'KaTeX_Size4-Regular.woff2',
  'KaTeX_Typewriter-Regular.woff2',
];

/** Where the layout rules live, for anything that has to inline them. */
export const MATH_STATIC_CSS = '/math/mathlive-static.css';

const FONT_LINK_ID = 'ml-fonts';
const STATIC_LINK_ID = 'ml-static';

/**
 * Put the font stylesheet in the document, once.
 *
 * Called from the formula editor's mount, never at module scope — a page
 * that never shows a formula should not carry the request.
 */
export function ensureFontCss(): void {
  appendStylesheet(FONT_LINK_ID, '/math/mathlive-fonts.css');
}

/**
 * Put both stylesheets in the document, once — the layout rules need the
 * faces, and neither declares the other's half.
 *
 * Called from the notebook's mount, never at module scope, for the same
 * reason as `ensureFontCss`.
 */
export function ensureMathCss(): void {
  ensureFontCss();
  appendStylesheet(STATIC_LINK_ID, MATH_STATIC_CSS);
}

function appendStylesheet(id: string, path: string): void {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href(path);
  document.head.append(link);
}
