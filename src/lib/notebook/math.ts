/**
 * Typeset the maths `renderMarkdown` left as source.
 *
 * markdown.ts emits `<span class="math math-inline" data-math="…">` and
 * `<div class="math math-display" data-math="…">` and imports nothing heavy;
 * this module is the other half. MathLive's `ssr` entry (~390 KB, no editor)
 * is `import()`ed on first use, so a page that never shows a formula never
 * pays for it, and its layout stylesheet rides on the font bundle the app
 * already vendors — one copy of the twenty faces, never a second.
 *
 * The same engine draws the formula editor's `<math-field>`, so what a note
 * shows is exactly what was written in the editor. It used to be KaTeX here
 * and nothing at all there.
 *
 * Browser-only: it rewrites the DOM in place. Not unit-tested; the browser
 * suite renders real notes through it.
 */
import { ensureMathCss } from '../math/fonts';

/** `convertLatexToMarkup`, once it has arrived. */
type Convert = (latex: string) => string;

let convert: Convert | null = null;
let loading: Promise<Convert> | null = null;

/**
 * MathLive's renderer, loaded once.
 *
 * The `ssr` entry, not the main one: it is the LaTeX engine without the
 * editor, half the size, and it touches no DOM. The editor is a separate
 * chunk that only opens with the formula dialog.
 */
export function loadMathEngine(): Promise<Convert> {
  if (convert) return Promise.resolve(convert);
  loading ??= import('mathlive/ssr').then((m) => {
    convert = (latex) => m.convertLatexToMarkup(latex);
    return convert;
  });
  return loading;
}

/**
 * Inline maths sits on the line, so it is set in TEXT style — sums and
 * integrals keep their limits beside them instead of stacking above and
 * below and pushing the line apart. MathLive's own default is display
 * style, which is right for `$$…$$` and wrong in a sentence.
 *
 * A formula that says `\displaystyle` for itself still wins: both are
 * switches, and the later one is the one in force.
 */
const styled = (latex: string, display: boolean) => (display ? latex : `\\textstyle ${latex}`);

/**
 * Draw `latex` into `el`, now if the engine is loaded and as soon as it is
 * otherwise.
 *
 * The wait is why the source text goes in first: a formula that is briefly
 * its own LaTeX reads as "not typeset yet", while an empty box reads as a
 * bug. Callers that need the markup to be THERE when they return (the HTML
 * export) await `loadMathEngine()` first.
 */
export function typeset(el: HTMLElement, latex: string, display: boolean): void {
  if (convert) {
    el.innerHTML = convert(styled(latex, display));
    return;
  }
  el.textContent = latex;
  void loadMathEngine().then((render) => {
    el.innerHTML = render(styled(latex, display));
  });
}

/**
 * Render every `[data-math]` element under `root` exactly once.
 *
 * A node that has been rendered is marked `data-math-rendered`, so calling
 * this again after a partial re-render only touches the new formulas.
 * MathLive renders what it cannot parse as red markup rather than throwing,
 * which is the behaviour we want; the catch is the net under the net.
 */
export async function renderMathIn(root: ParentNode): Promise<void> {
  const nodes = root.querySelectorAll<HTMLElement>('[data-math]:not([data-math-rendered])');
  if (nodes.length === 0) return;
  ensureMathCss();
  const render = await loadMathEngine();
  for (const node of nodes) {
    // Guard again after the await: a concurrent call may have got here first.
    if (node.hasAttribute('data-math-rendered')) continue;
    node.setAttribute('data-math-rendered', '');
    const source = node.getAttribute('data-math') ?? '';
    try {
      node.innerHTML = render(styled(source, node.classList.contains('math-display')));
    } catch (error) {
      node.classList.add('math-error');
      node.title = error instanceof Error ? error.message : String(error);
    }
  }
}
