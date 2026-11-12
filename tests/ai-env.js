// A developer machine is not CI: an exported ANTHROPIC_BASE_URL, GEMINI_API_KEY
// or AZURE_OPENAI_ENDPOINT in the shell otherwise reaches the tests, and both
// `resolveConfig` and every spawned `src/server.js` read them. The suites that
// care blank AI_* and OPENAI_* themselves; they missed the other three names,
// so the same suite was green on CI and red on a machine with a provider
// configured. Load this before the test files (`--import`) and the environment
// each test starts from is the empty one it was written for. A test that wants
// a provider sets it explicitly, as `withEnv` and `coordination-runs` already do.
//
// The server children copy `{...process.env}`, so clearing here reaches them
// too. `PI_KEEP_AI_ENV=1` opts out, for reproducing a report about the real
// environment on purpose.
const PROVIDER_VARS = [
  'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_API_STYLE', 'AI_API_PROTOCOL', 'AI_TIMEOUT_MS',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_API_KEY',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_VERSION',
];

if (!process.env.PI_KEEP_AI_ENV) {
  for (const name of PROVIDER_VARS) delete process.env[name];
}

// A spawned test server would otherwise pair "This computer" and run a real agent (src/local-agent.js),
// which opens a browser and polls in the background. A test that wants it sets LOCAL_AGENT itself.
if (process.env.LOCAL_AGENT === undefined) process.env.LOCAL_AGENT = '0';
