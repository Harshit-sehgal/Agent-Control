/** The one list of files that make up the UI.
 *
 * `shared/` is served directly by the Node server and copied to `docs/` by the
 * Pages build, so the two had a hand-maintained copy of the same list. A module
 * imported by `index.html` but missing from one of them is a bare 404 with no
 * test failure, which is why the list lives here once and both readers import
 * it (`scripts/build-pages.js`, `src/server.js`).
 *
 * Plain data and no imports: like the rest of `shared/`, this file must stay
 * browser-safe. Do not add this file to the list — it is build/server plumbing,
 * not a page asset, and nothing in the UI imports it.
 */
export const ASSETS = [
  // Entry point and styles.
  'index.html', 'app.css',
  // The UI modules the entry points import.
  'transport.js', 'local-api.js', 'app.js',
  'ui-kit.js', 'ui-model.js', 'ui-store.js', 'ui-dialogs.js', 'ui-chat.js', 'ui-views.js', 'ui-panel.js', 'ui-sheets.js', 'ui-admin.js', 'ui-actions.js', 'ui-takeover.js', 'ui-fx.js', 'ui-push.js', 'sw.js',
  // Browser-safe logic shared with the server.
  'core.js', 'errors.js', 'workflow.js', 'tasks.js', 'evidence.js', 'contracts.js', 'bot-settings.js', 'bot-browser.js', 'bot-create.js', 'bot-link.js', 'reply-blocks.js', 'subagents.js', 'retention.js', 'memory.js',
  'coordination.js', 'chats.js', 'group-simulator.js', 'chat-engine.js', 'usability.js', 'local-runs.js', 'ai-presets.js',
  // Static pages and install assets.
  'demo-feed.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
];
