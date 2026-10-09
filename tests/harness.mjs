import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

export const plain = value => JSON.parse(JSON.stringify(value));
export const report = (id = 'alpha', overrides = {}) => ({
  providerId: id, providerName: id, buckets: [
    { id: 'five-hour', label: '5 小时', unit: 'percent', used: 58, remaining: 42, limit: 100 },
    { id: 'weekly', label: '本周', unit: 'percent', used: 13, remaining: 87, limit: 100 },
  ], metrics: [], ...overrides,
});

/** Run the public extension entrypoint with deterministic pi/engine/clock/IO boundaries. */
export async function createHarness(options = {}) {
  const state = { now: 1_800_000_000_000, config: undefined, calls: [], statuses: [], notifications: [],
    timers: [], active: 0, maxActive: 0, ...options };
  const adapters = options.adapters ?? [{ id: 'alpha', displayName: 'Alpha' }];
  const commands = new Map();
  const events = new Map();
  const auth = () => ({ fingerprint: 'fingerprint', secrets: ['secret-key'] });
  const ctx = {
    model: { provider: 'alpha', id: 'model' }, hasUI: false,
    sessionManager: { getSessionId: () => 'session' },
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: true }),
      getProvider: () => ({ baseUrl: 'https://provider.example' }),
      getProviderAuth: async () => ({ auth: { apiKey: 'extra-key' } }),
    },
    ui: {
      theme: { prefix: 'color', fg(color, text) { return `${this.prefix}:${color}(${text})`; } },
      setStatus: (key, text) => state.statuses.push({ key, text }),
      notify: (text, level) => state.notifications.push({ text, level }),
    },
  };
  const engine = {
    usageAdapters: () => adapters,
    providerIsConfigured: (_ctx, id) => state.configured?.(id) ?? true,
    resolveUsageAuth: async (...args) => state.resolveAuth ? state.resolveAuth(...args) : auth(),
    queryProviderUsage: async (...args) => {
      const [adapter, auth, signal, timeout, guard] = args;
      state.calls.push({ id: adapter.id, auth, signal, timeout });
      state.active++; state.maxActive = Math.max(state.maxActive, state.active);
      try { return state.query ? await state.query(...args) : (await guard(), report(adapter.id)); }
      finally { state.active--; }
    },
    redactUsageError: (message, secrets = []) => secrets.reduce((s, secret) => s.split(String(secret)).join('[REDACTED]'), message),
    abortError: () => Object.assign(new Error('aborted'), { name: 'AbortError' }),
    isStaleExtensionContextError: error => error instanceof Error && error.message.includes('This extension ctx is stale after session replacement or reload'),
    errorMessage: error => error?.message ?? String(error),
    // fast 纯函数：默认与库内置语义一致的可控替身，给 fastStatusSpans / /fast / 改写链路用
    codexFastAvailability: (model, enabled) => state.fastAvailability ? state.fastAvailability(model, enabled)
      : (model?.provider === 'openai-codex' ? { kind: 'available', enabled } : { kind: 'not-codex' }),
    codexFastIsEffective: (model, enabled) => state.fastEffective ? state.fastEffective(model, enabled)
      : (model?.provider === 'openai-codex' && Boolean(enabled)),
    codexFastStatusLabel: (status, on) => (on ? `fast ${status}` : status),
    correctCodexFastMessageCost: (message, model, fastRequested) => state.fastCorrect?.(message, model, fastRequested),
    rewriteCodexFastPayload: (payload, model, enabled) => state.fastRewrite ? state.fastRewrite(payload, model, enabled) : payload,
    createUsageSettingsRuntime: () => state.fastSettings ?? {
      get: () => ({ kind: 'loaded', settings: { codexFastMode: state.fastMode ?? false } }),
      reload: async () => { state.fastReloads = (state.fastReloads ?? 0) + 1; return { kind: 'loaded', settings: { codexFastMode: state.fastMode ?? false } }; },
      update: async patch => { state.fastPatches = state.fastPatches ?? []; state.fastPatches.push(patch); state.fastMode = patch.codexFastMode ?? state.fastMode; },
      flush: async () => { state.fastFlushes = (state.fastFlushes ?? 0) + 1; },
    },
  };
  const context = vm.createContext({
    console, AbortController, Error,
    Date: class extends Date { static now() { return state.now; } },
    process: { env: { PI_CODING_AGENT_DIR: '/test-agent' } },
    setInterval: (fn, ms) => { const timer = { fn, ms, unref() { this.unreferenced = true; } }; state.timers.push(timer); return timer; },
    clearInterval: timer => { timer.cleared = true; },
  });
  const mocks = {
    'node:fs': { readFileSync: () => { if (state.config === undefined) throw new Error('ENOENT'); return state.config; } },
    'node:os': { homedir: () => '/home/test' },
    'node:path': { join: (...args) => args.join('/') },
    '@earendil-works/pi-coding-agent': { readStoredCredential: async id => state.credential?.(id) },
    '@narumitw/pi-usage/dist/index.ts': engine,
  };
  const modules = new Map();
  const loading = new Map();
  function load(file) {
    // The linker requests shared dependencies concurrently; cache the pending
    // load too, otherwise commands and lifecycle handlers get different state.
    if (!loading.has(file)) loading.set(file, createModule(file));
    return loading.get(file);
  }
  async function createModule(file) {
    if (mocks[file]) {
      const exports = mocks[file];
      const mod = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier: file });
      modules.set(file, mod); return mod;
    }
    const source = await readFile(file, 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    const mod = new vm.SourceTextModule(outputText, { context, identifier: file });
    modules.set(file, mod); return mod;
  }
  const entry = await load(resolve(process.env.USAGE_DASH_TEST_ENTRY ?? 'extensions/usage-dash.ts'));
  await entry.link((specifier, parent) => load(specifier.startsWith('.') ? resolve(dirname(parent.identifier), specifier) : specifier));
  await entry.evaluate();
  entry.namespace.default({ registerCommand: (name, command) => commands.set(name, command), on: (name, fn) => events.set(name, fn) });
  return { state, ctx, api: entry.namespace, commands, events,
    status: modules.get(resolve(dirname(entry.identifier), '../lib/status.ts'))?.namespace,
    fast: modules.get(resolve(dirname(entry.identifier), '../lib/fast.ts'))?.namespace,
    command: (args = '') => commands.get('usage').handler(args, ctx),
    event: (name, event = {}, eventCtx = ctx) => events.get(name)(event, eventCtx),
    settle: async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); },
  };
}
