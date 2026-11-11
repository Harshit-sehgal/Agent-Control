/** Provider presets and wire protocols for bring-your-own-key models.
 *
 * A provider is not just "an OpenAI URL": Anthropic's Messages API, Google's
 * generateContent and OpenAI's two shapes disagree about headers, body and the
 * model catalogue. This file names the five wire protocols once, so the server
 * (`src/ai.js`) and the settings page (`shared/ui-admin.js`) agree on the ids
 * and the preset endpoints instead of each keeping a list.
 *
 * Plain data plus three pure helpers: no imports, no DOM, no Node builtins
 * (it is served to the browser and imported by the server, like the rest of
 * `shared/`).
 */

/** The wire shapes the server can speak. `id` is stored on the provider. */
export const PROTOCOLS = [
  {
    id: 'openai-chat',
    label: 'OpenAI Chat Completions',
    hint: 'POST /chat/completions. The compatibility mode almost every provider speaks — OpenAI, Groq, Mistral, OpenRouter, vLLM, Ollama.',
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    hint: 'POST /responses. OpenAI’s newer shape; also what api.openai.com is detected as.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Messages',
    hint: 'POST /messages with x-api-key and anthropic-version. Claude models.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    hint: 'POST /models/{model}:generateContent with x-goog-api-key. Google AI Studio keys.',
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    hint: 'POST /openai/deployments/{deployment}/chat/completions?api-version=… with an api-key header. Needs the resource endpoint and an API version.',
    needsApiVersion: true,
  },
];

export const PROTOCOL_IDS = PROTOCOLS.map(p => p.id);
export const DEFAULT_PROTOCOL = 'openai-chat';

/** Old shorthand (`AI_API_STYLE=chat|responses`) and friendly aliases, mapped
 * onto a protocol id. Anything unknown is `null` so callers can fall back to
 * host detection instead of silently sending the wrong body shape. */
const ALIASES = {
  chat: 'openai-chat', 'chat-completions': 'openai-chat', openai: 'openai-chat', compatible: 'openai-chat',
  responses: 'openai-responses', response: 'openai-responses', 'openai-responses': 'openai-responses',
  anthropic: 'anthropic', messages: 'anthropic', claude: 'anthropic',
  gemini: 'gemini', google: 'gemini', 'google-gemini': 'gemini',
  azure: 'azure-openai', 'azure-openai': 'azure-openai', openai_azure: 'azure-openai', azureopenai: 'azure-openai',
};

/** @returns {string|null} a protocol id, or null when the value is unknown. */
export function normaliseProtocol(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return null;
  if (PROTOCOL_IDS.includes(key)) return key;
  return ALIASES[key] || null;
}

/** Guess the protocol from an endpoint. The hosts whose shape is not
 * OpenAI-compatible are special-cased; everything else is chat, which is what a
 * custom gateway, a router or a local server expects. */
export function inferProtocol(baseUrl) {
  let host = '';
  try { host = new URL(String(baseUrl || '')).hostname.toLowerCase(); } catch {}
  if (!host) return DEFAULT_PROTOCOL;
  if (/(^|\.)anthropic\.com$/.test(host)) return 'anthropic';
  if (/(^|\.)generativelanguage\.googleapis\.com$/.test(host)) return 'gemini';
  if (/(^|\.)openai\.azure\.com$/.test(host)) return 'azure-openai';
  if (/(^|\.)openai\.com$/.test(host)) return 'openai-responses';
  return DEFAULT_PROTOCOL;
}

/** The endpoint suffixes a user may paste instead of the base. Someone copying
 * "https://api.openai.com/v1/chat/completions" out of an SDK call means the base,
 * and "…/v1/models" the same, so the path is trimmed back to a base URL. */
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|completions|responses|messages|models|embeddings)$/i;
const AZURE_DEPLOYMENT = /\/openai\/deployments\/[^/]+(?:\/chat\/completions)?$/i;

/** @returns {string} base URL without a pasted endpoint path or trailing slash. */
export function normaliseBaseUrl(baseUrl, protocol = DEFAULT_PROTOCOL) {
  let url = String(baseUrl || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    let path = parsed.pathname.replace(/\/+$/, '');
    // A deployment path is unmistakably Azure, whatever protocol was selected.
    path = path.replace(AZURE_DEPLOYMENT, '');
    // The bare "/openai" suffix is only ours to drop on Azure: on any other
    // protocol it is a real segment (a gateway may live at .../openai/models),
    // and stripping it sent the catalogue request to /models instead.
    if (protocol === 'azure-openai') path = path.replace(/\/openai$/i, '');
    path = path.replace(ENDPOINT_SUFFIX, '');
    // A base of "/v1" is kept; an empty path stays empty and the 404 hint tells
    // the user which suffix that provider needs.
    parsed.pathname = path || '/';
    parsed.search = '';
    parsed.hash = '';
    url = parsed.toString().replace(/\/+$/, '').replace(/\/$/, '');
    return protocol === 'azure-openai' ? url.replace(/\/openai$/, '') : url;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

/** Model ids that cannot answer a chat request. Providers list everything on
 * one endpoint (embeddings, speech, image, moderation), so the picker offers the
 * conversational ones and keeps the rest selectable by hand. */
const NON_CHAT = /(embed|whisper|(^|[/-])tts|dall-e|gpt-image|image-|imagen|moderation|rerank|(^|[/-])bge|(^|[/-])e5-|stable-diffusion|sdxl|(^|[/-])flux|audio|realtime|transcribe|veo|chirp|(^|[/-])aqa)/i;
export function isChatModel(id) {
  return typeof id === 'string' && id.length > 0 && !NON_CHAT.test(id);
}

export function protocolById(id) {
  return PROTOCOLS.find(p => p.id === normaliseProtocol(id)) || null;
}

/** Presets fill the endpoint for the well-known providers. `keyOptional` marks
 * local servers that ignore the key — the form still asks for one because the
 * request carries it, and a local server accepts any string. */
export const PROVIDER_PRESETS = [
  { id: 'openai', label: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', note: 'gpt-5, o-series, gpt-4.1 — the Responses shape is OpenAI’s current one.' },
  { id: 'anthropic', label: 'Anthropic (Claude)', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys', note: 'Claude models through the Messages API.' },
  { id: 'gemini', label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/apikey', note: 'A key from AI Studio. The model list is fetched from the API.' },
  { id: 'xai', label: 'xAI (Grok)', protocol: 'openai-chat', baseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai', note: 'Grok models, OpenAI-compatible.' },
  { id: 'groq', label: 'Groq', protocol: 'openai-chat', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', note: 'Fast hosted open models.' },
  { id: 'mistral', label: 'Mistral', protocol: 'openai-chat', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', note: '' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', note: '' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', note: 'One key for many vendors; the model list is long.' },
  { id: 'together', label: 'Together AI', protocol: 'openai-chat', baseUrl: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys', note: '' },
  { id: 'fireworks', label: 'Fireworks AI', protocol: 'openai-chat', baseUrl: 'https://api.fireworks.ai/inference/v1', keyUrl: 'https://fireworks.ai/account/api-keys', note: '' },
  { id: 'perplexity', label: 'Perplexity', protocol: 'openai-chat', baseUrl: 'https://api.perplexity.ai', keyUrl: 'https://www.perplexity.ai/settings/api', note: 'Its /models list may be empty; type a model id by hand.' },
  { id: 'cerebras', label: 'Cerebras', protocol: 'openai-chat', baseUrl: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', note: '' },
  { id: 'cohere', label: 'Cohere', protocol: 'openai-chat', baseUrl: 'https://api.cohere.ai/compatibility/v1', keyUrl: 'https://dashboard.cohere.com/api-keys', note: 'Cohere’s OpenAI-compatibility endpoint.' },
  { id: 'qwen', label: 'Qwen (DashScope)', protocol: 'openai-chat', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.alibabacloud.com', note: 'Alibaba’s international compatibility endpoint.' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', protocol: 'openai-chat', baseUrl: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys', note: '' },
  { id: 'zhipu', label: 'Zhipu (GLM)', protocol: 'openai-chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', note: '' },
  { id: 'deepinfra', label: 'DeepInfra', protocol: 'openai-chat', baseUrl: 'https://api.deepinfra.com/v1/openai', keyUrl: 'https://deepinfra.com/dash/api_keys', note: '' },
  { id: 'hyperbolic', label: 'Hyperbolic', protocol: 'openai-chat', baseUrl: 'https://api.hyperbolic.xyz/v1', keyUrl: 'https://app.hyperbolic.xyz/settings', note: '' },
  { id: 'nebius', label: 'Nebius', protocol: 'openai-chat', baseUrl: 'https://api.studio.nebius.com/v1', keyUrl: 'https://studio.nebius.com', note: '' },
  { id: 'nvidia', label: 'NVIDIA NIM', protocol: 'openai-chat', baseUrl: 'https://integrate.api.nvidia.com/v1', keyUrl: 'https://build.nvidia.com', note: '' },
  { id: 'github-models', label: 'GitHub Models', protocol: 'openai-chat', baseUrl: 'https://models.github.ai/inference', keyUrl: 'https://github.com/settings/tokens', note: 'A GitHub token with the models scope.' },
  { id: 'azure', label: 'Azure OpenAI', protocol: 'azure-openai', baseUrl: '', needsEndpoint: true, note: 'Paste your resource endpoint (https://NAME.openai.azure.com) and the API version. The model id is the deployment name.' },
  { id: 'litellm', label: 'LiteLLM proxy (local)', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:4000/v1', keyOptional: true, note: 'A local LiteLLM proxy in front of anything. Any string works as the key unless you set one.' },
  { id: 'ollama', label: 'Ollama (local)', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:11434/v1', keyOptional: true, note: 'Local server. Any string works as the key; the real model list comes from Ollama.' },
  { id: 'lmstudio', label: 'LM Studio (local)', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1234/v1', keyOptional: true, note: 'Local server. Any string works as the key.' },
  { id: 'vllm', label: 'vLLM / llama.cpp (local)', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:8000/v1', keyOptional: true, note: 'Local OpenAI-compatible server. Any string works as the key.' },
  { id: 'localai', label: 'LocalAI (local)', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:8080/v1', keyOptional: true, note: 'Local server. Any string works as the key.' },
  { id: 'jan', label: 'Jan (local)', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1337/v1', keyOptional: true, note: 'Jan’s local server. Any string works as the key.' },
  { id: 'custom', label: 'Custom endpoint', protocol: 'openai-chat', baseUrl: '', needsEndpoint: true, note: 'A gateway, a proxy, or your own router. Pick the protocol it speaks.' },
];

export function presetById(id) {
  const key = String(id || '').trim().toLowerCase();
  return PROVIDER_PRESETS.find(p => p.id === key) || null;
}

/** A model that runs on the owner's own subscription instead of an API key.
 *
 * The paired local agent spawns the unmodified `claude` or `codex` CLI, which the
 * owner signed in to in their own terminal. A provider of this kind holds no key,
 * no endpoint and no vault row: it names an engine and, optionally, a model.
 * `signIn` is the sentence shown when that CLI is not signed in on the machine. */
export const LOCAL_CLI_KIND = 'local-cli';
export const LOCAL_CLI_ENGINES = [
  {id: 'claude', label: 'Claude (your subscription)', binary: 'claude', signIn: 'Run `claude` and sign in on that machine.'},
  {id: 'codex', label: 'ChatGPT (your subscription)', binary: 'codex', signIn: 'Run `codex login` and sign in on that machine.'},
];
export const LOCAL_CLI_ENGINE_IDS = LOCAL_CLI_ENGINES.map(e => e.id);

/** @returns the engine record for an id, or null. */
export const cliEngineById = id => LOCAL_CLI_ENGINES.find(e => e.id === String(id ?? '').trim().toLowerCase()) || null;

/** A CLI model id: empty (the CLI's own default) or a plain name. It must not
 * begin with `-`, because it travels as the value after `--model` and a value
 * that looks like a flag could be read as one. `[` `]` allow ids like `opus[1m]`.
 * @returns {string|null} the cleaned id, '' for none, or null when it is refused. */
export function cleanCliModel(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,79}$/.test(text) ? text : null;
}
