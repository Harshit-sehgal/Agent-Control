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
  'index.html', 'app.css', 'shell.css', 'profile.css',
  // The UI modules the entry points import.
  'transport.js', 'local-api.js', 'app.js',
  'ui-kit.js', 'ui-model.js', 'ui-face.js', 'ui-company.js', 'ui-feed.js', 'ui-store.js', 'ui-dialogs.js', 'ui-chat.js', 'ui-shell.js', 'ui-conversation.js', 'ui-profile-model.js', 'ui-profile.js', 'ui-reorder.js', 'ui-gestures.js', 'ui-asks.js', 'ui-settings.js', 'ui-sheets.js', 'ui-admin.js', 'ui-actions.js', 'ui-takeover.js', 'ui-computer.js', 'ui-computer-view.js', 'ui-connect-model.js', 'ui-connect.js', 'ui-fx.js', 'ui-push.js', 'sw.js',
  // Browser-safe logic shared with the server.
  'core.js', 'errors.js', 'workflow.js', 'tasks.js', 'contracts.js', 'bot-settings.js', 'company.js', 'threads.js', 'off-job.js', 'bot-browser.js', 'bot-create.js', 'hire.js', 'offline-bots.js', 'bot-link.js', 'ask-limits.js', 'asks.js', 'activity-log.js', 'runaway.js', 'reply-blocks.js', 'subagents.js', 'retention.js', 'memory.js', 'run-state.js',
  // Connectors: the shape, the `connector` block and the envelope list. Imported by coordination.js, so the demo needs it.
  'connectors.js',
  'coordination.js', 'chats.js', 'group-simulator.js', 'locks.js', 'ai-presets.js', 'run-follow.js',
  // Static pages and install assets.
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
];
