import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from './harness.mjs';

const codexModel = { provider: 'openai-codex', id: 'gpt-5.6-sol', baseUrl: 'https://chatgpt.com/backend-api' };
// pi-codex-accounts 克隆账号：线上以 openai-codex 名义发请求，消息回复后重标回克隆 id
const labeledModel = { ...codexModel, provider: 'openai-codex-yufen-plus' };

test('fastStatusSpans: fast 生效时输出标注，未生效或非 codex 为空', async () => {
  const { fast } = await createHarness();
  assert.deepEqual(plain(fast.fastStatusSpans(codexModel, true)), [{ text: 'fast', color: 'warning' }]);
  assert.deepEqual(plain(fast.fastStatusSpans(codexModel, false)), []);
  // 引擎默认替身按 provider === openai-codex 判定，标签账号经视图映射后同样点亮
  assert.deepEqual(plain(fast.fastStatusSpans(labeledModel, true)), [{ text: 'fast', color: 'warning' }]);
  assert.deepEqual(plain(fast.fastStatusSpans({ provider: 'alpha', id: 'model' }, true)), []);
});

test('/fast: codex 模型可切换，偏好写入设置运行时并刷新状态栏', async () => {
  const { ctx, commands, state, settle } = await createHarness();
  ctx.hasUI = true;
  ctx.model = codexModel;
  await commands.get('fast').handler('', ctx);
  await settle();
  assert.deepEqual(plain(state.fastPatches ?? []), [{ codexFastMode: true }]);
  assert.ok(state.notifications.some(n => /Fast mode enabled/.test(n.text)));
  // 再切一次回到关闭
  state.fastMode = true;
  await commands.get('fast').handler('', ctx);
  await settle();
  assert.deepEqual(plain(state.fastPatches ?? []), [{ codexFastMode: true }, { codexFastMode: false }]);
});

test('/fast: 非 codex 模型拒绝，标签账号经映射后可用', async () => {
  const { ctx, commands, state, settle } = await createHarness();
  ctx.hasUI = true;
  ctx.model = { provider: 'alpha', id: 'model' };
  await commands.get('fast').handler('', ctx);
  await settle();
  assert.equal(state.fastPatches, undefined);
  assert.ok(state.notifications.some(n => /only for the active OpenAI Codex model/.test(n.text)));

  ctx.model = labeledModel;
  await commands.get('fast').handler('', ctx);
  await settle();
  assert.deepEqual(plain(state.fastPatches ?? []), [{ codexFastMode: true }]);
});

test('before_provider_request: fast 开启时改写 service_tier 并登记待校正请求', async () => {
  const rewriteState = { rewritten: undefined };
  const { ctx, commands, events, settle } = await createHarness({
    fastRewrite: (payload, model, enabled) => {
      rewriteState.rewritten = { payload, model, enabled };
      return enabled && model?.provider === 'openai-codex' ? { ...payload, service_tier: 'priority' } : payload;
    },
  });
  ctx.hasUI = true;
  ctx.model = labeledModel;
  await commands.get('fast').handler('', ctx);
  await settle();

  const out = events.get('before_provider_request')({ payload: { model: 'gpt-5.6-sol' } }, ctx);
  assert.equal(out.service_tier, 'priority');
  // 改写视图映射到内置 id，与线上请求名义一致
  assert.equal(rewriteState.rewritten.model.provider, 'openai-codex');
});

test('message_end: fast 请求的成本校正生效且标签账号 provider 还原', async () => {
  const corrected = [];
  const { ctx, events, settle } = await createHarness({
    fastMode: true,
    fastRewrite: (payload, model, enabled) => (enabled ? { ...payload, service_tier: 'priority' } : payload),
    fastCorrect: (message, model, fastRequested) => {
      corrected.push({ message, model, fastRequested });
      return { ...message, usage: { ...message.usage, cost: { total: 2 } } };
    },
  });
  ctx.model = labeledModel;
  events.get('before_provider_request')({ payload: {} }, ctx);
  const result = events.get('message_end')({ message: { role: 'assistant', provider: 'openai-codex-yufen-plus', model: 'gpt-5.6-sol' } }, ctx);
  await settle();
  // 校正入参：消息与模型都映射到内置 id，保持一致性校验可过
  assert.equal(corrected[0].message.provider, 'openai-codex');
  assert.equal(corrected[0].model.provider, 'openai-codex');
  assert.equal(corrected[0].fastRequested, true);
  // 返回消息的 provider 还原为克隆 id，避免会话里模型归属错乱
  assert.equal(result.message.provider, 'openai-codex-yufen-plus');
});

test('message_end: 未登记的普通请求不做任何改写', async () => {
  const { ctx, events } = await createHarness({ fastCorrect: () => { throw new Error('should not correct'); } });
  ctx.model = codexModel;
  const result = events.get('message_end')({ message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.6-sol' } }, ctx);
  assert.equal(result, undefined);
});

test('补充型号 gpt-6.1-sol：/fast 可切换且改写与标注均生效', async () => {
  const model61 = { provider: 'openai-codex', id: 'gpt-6.1-sol', baseUrl: 'https://chatgpt.com/backend-api', api: 'openai-codex-responses' };
  const { fast, ctx, commands, events, state, settle } = await createHarness();
  ctx.hasUI = true;
  ctx.model = model61;
  // 库替身只认 allowlist 内型号，补充型号的可用性完全走本地路径
  await commands.get('fast').handler('', ctx);
  await settle();
  assert.deepEqual(plain(state.fastPatches ?? []), [{ codexFastMode: true }]);
  const out = events.get('before_provider_request')({ payload: { model: 'gpt-6.1-sol' } }, ctx);
  assert.equal(out.service_tier, 'priority');
  assert.deepEqual(plain(fast.fastStatusSpans(model61, true)), [{ text: 'fast', color: 'warning' }]);
  // 非官方端点仍拒绝
  const proxied = { ...model61, baseUrl: 'https://proxy.example/v1' };
  const denied = await createHarness();
  denied.ctx.hasUI = true;
  denied.ctx.model = proxied;
  await denied.commands.get('fast').handler('', denied.ctx);
  await denied.settle();
  assert.equal(denied.state.fastPatches, undefined);
});

test('补充型号 gpt-6.1-sol：fast 成本按 2 倍校正', async () => {
  const model61 = { provider: 'openai-codex', id: 'gpt-6.1-sol', baseUrl: 'https://chatgpt.com/backend-api', api: 'openai-codex-responses' };
  const { ctx, events, settle } = await createHarness({
    fastMode: true,
    fastRewrite: (payload, model, enabled) => (enabled ? { ...payload, service_tier: 'priority' } : payload),
  });
  ctx.model = model61;
  events.get('before_provider_request')({ payload: {} }, ctx);
  const usage = { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, cost: { input: 0.002, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.022 } };
  const result = events.get('message_end')({ message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-6.1-sol', usage } }, ctx);
  await settle();
  assert.equal(result.message.usage.cost.total, 0.022 * 2);
  assert.equal(result.message.usage.cost.output, 0.02 * 2);
});

test('状态栏: fast 生效时 publishFromResults 前置 fast 标注', async () => {
  const { ctx, state, event, command, settle } = await createHarness({
    fastMode: true,
    adapters: [{ id: 'openai-codex', displayName: 'OpenAI Codex' }],
  });
  ctx.model = codexModel;
  await command('');
  await settle();
  const published = state.statuses.at(-1);
  assert.equal(published.text.replace(/color:\w+\(([^)]*)\)/g, '$1'), 'fast 42%·5h 87%·7d');
  // 关闭后标注消失
  state.fastMode = false;
  await event('model_select', { model: codexModel });
  await settle();
  assert.doesNotMatch(state.statuses.at(-1).text, /fast/);
});

test('状态栏: 纯文本 fast 与用量分隔，关闭后无多余空格', async () => {
  const { ctx, state, command, settle } = await createHarness({
    fastMode: true,
    adapters: [{ id: 'openai-codex', displayName: 'OpenAI Codex' }],
  });
  ctx.model = codexModel;
  ctx.ui.theme.fg = (_color, text) => text;
  await command();
  await settle();
  assert.equal(state.statuses.at(-1).text, 'fast 42%·5h 87%·7d');
  state.fastMode = false;
  await command();
  await settle();
  assert.equal(state.statuses.at(-1).text, '42%·5h 87%·7d');
});

test('状态栏: 无用量数据时 fast 标记无尾随空格', async () => {
  const { ctx, state, command, settle } = await createHarness({
    fastMode: true,
    adapters: [{ id: 'openai-codex', displayName: 'OpenAI Codex' }],
    query: async () => ({ providerId: 'openai-codex', buckets: [], metrics: [] }),
  });
  ctx.model = codexModel;
  ctx.ui.theme.fg = (_color, text) => text;
  await command();
  await settle();
  assert.equal(state.statuses.at(-1).text, 'fast');
});
