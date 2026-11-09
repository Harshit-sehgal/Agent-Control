/**
 * The two cache-busting rewrites the Pages build applies to a copied bundle.
 *
 * They live here, and both the build and `tests/pages-bundle.test.js` import
 * them, because a test that re-implements the build's regexes with the same
 * blind spot can never catch drift: the old copies required a literal `./` and
 * a bare `\w+` name, so a subdirectory module (`./ui/x.js`) or a dotted one
 * (`./ui-kit.v2.js`) shipped with no `?v=` and returned stale after a deploy,
 * and the test would have agreed.
 */

/** href/src of a local script or stylesheet, with or without the `./` prefix.
 * `https://` cannot match: the class stops at `:`. */
export const TAG_URL = /(href|src)="(\.?\/?[\w-]+(?:\.(?:js|css)))"/g;

/** A relative ES module specifier in `import … from './x.js'` or `import './x.js'`. */
export const MODULE_URL = /((?:from|import)\s*)(['"])(\.\/[\w./-]+?\.m?js)\2/g;

export const stampDocument = (html, version) => html.replace(TAG_URL, (_, attr, url) => `${attr}="${url}?v=${version}"`);

export const stampImports = (source, version) => source.replace(MODULE_URL, (_, keyword, quote, url) => `${keyword}${quote}${url}?v=${version}${quote}`);
