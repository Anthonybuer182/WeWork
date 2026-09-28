/**
 * Stylesheet imports.
 *
 * `build-panel.mjs` compiles every `.css` file into a module that injects a
 * `<style>` on first evaluation and default-exports the text (the `css-inject`
 * plugin there), so a `.css` import is a string at runtime.
 *
 * TypeScript does not agree: it has no idea what a `.css` specifier is, and
 * `allowArbitraryExtensions` only tells it to look for a sidecar `*.d.css.ts` —
 * a file this repo does not generate. Without this, every stylesheet import in
 * the panel and in the vendored renderers is "cannot find module".
 */
declare module '*.css' {
  const css: string;
  export default css;
}
