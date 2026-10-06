import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHarness, plain, report } from './harness.mjs';

const metric = (value, currency, id) => ({ value, currency, id, unit: 'currency', label: '余额' });

test('public exports, percentage boundaries, window precedence and balance selection', async () => {
  const { api } = await createHarness();
  assert.deepEqual(Object.keys(api).sort(), ['buildStatusSpans', 'default', 'formatCurrencyAmount', 'pickBalance', 'remainingPercent', 'tierColor'].sort());
  assert.deepEqual([0, 19, 20, 49, 50, 100].map(api.tierColor), ['error','error','warning','warning','success','success']);
  for (const [remaining, limit, expected] of [[10,20,50],[-1,20,0],[30,20,100],[1,0,undefined],[undefined,10,undefined]]) {
    assert.equal(api.remainingPercent({ remaining, limit }), expected);
  }
  assert.deepEqual(plain(api.buildStatusSpans(report('alpha', { metrics: [metric(1,'USD')] }))), [
    { text: '42%', color: 'warning' }, { text: '·5h' }, { text: ' ' }, { text: '87%', color: 'success' }, { text: '·7d' },
  ]);
  assert.deepEqual(plain(api.buildStatusSpans(report('alpha', { buckets: [], metrics: [metric(1,'USD')] }))), [{ text: '$1.00', color: 'success' }]);
  assert.deepEqual(plain(api.buildStatusSpans(report('alpha', { buckets: [], metrics: [] }))), []);
  assert.equal(api.formatCurrencyAmount(1.239, 'CNY'), '¥1.24');
  assert.equal(api.formatCurrencyAmount(1, 'EUR'), '1.00 EUR');
  assert.equal(api.pickBalance([metric(NaN,'USD'), metric(Infinity,'CNY')]), undefined);
  const reference = metrics => {
    const pool = metrics.filter(m => m.unit === 'currency' && typeof m.value === 'number' && Number.isFinite(m.value));
    const totals = pool.filter(m => m.id?.endsWith('-total'));
    const candidates = totals.length ? totals : pool;
    const chosen = candidates.find(m => m.currency === 'USD') ?? candidates.find(m => m.currency === 'CNY') ?? candidates[0];
    return chosen ? { value: chosen.value, currency: chosen.currency ?? '' } : undefined;
  };
  // Exhaust every ordered triple: totals dominate currency, ties keep the first metric.
  const candidates = [metric(1,'USD'),metric(2,'CNY'),metric(3,'EUR'),metric(4,undefined),metric(5,'USD','usd-total'),metric(6,'CNY','cny-total'),metric(7,'EUR','eur-total')];
  for (const a of candidates) for (const b of candidates) for (const c of candidates) {
    assert.deepEqual(plain(api.pickBalance([a,b,c])), reference([a,b,c]));
  }
});

test('60-second cache boundary, force/refresh aliases, timeout and failure redaction', async () => {
  const h = await createHarness();
  await h.command(); await h.command();
  assert.equal(h.state.calls.length, 1);
  assert.match(h.state.notifications.at(-1).text, /0 实时 \/ 1 缓存/);
  h.state.now += 59_999; await h.command(); assert.equal(h.state.calls.length, 1);
  h.state.now++; await h.command(); assert.equal(h.state.calls.length, 2);
  await h.command('refresh'); await h.command('FORCE'); assert.equal(h.state.calls.length, 4);
  assert.ok(h.state.calls.every(c => c.timeout === 15_000 && c.signal instanceof AbortSignal));
  h.state.query = async () => { throw new Error('request rejected secret-key'); };
  await h.command('refresh');
  assert.match(h.state.notifications.at(-1).text, /request rejected \[REDACTED\]/);
  assert.ok(!h.state.notifications.at(-1).text.includes('secret-key'));
});

test('worker pool caps concurrency at four and sorts success before errors', async () => {
  const adapters = ['zulu','delta','alpha','charlie','bravo','echo'].map(id => ({ id, displayName: id }));
  const pending = [];
  const h = await createHarness({ adapters, query: async adapter => {
    await new Promise(resolve => pending.push(resolve));
    if (adapter.id === 'alpha') throw new Error('failed');
    return report(adapter.id);
  } });
  const command = h.command(); await h.settle();
  assert.equal(h.state.active, 4);
  pending.splice(0).reverse().forEach(resolve => resolve()); await h.settle();
  pending.splice(0).forEach(resolve => resolve()); await command;
  assert.equal(h.state.maxActive, 4); assert.equal(h.state.calls.length, 6);
  const text = h.state.notifications.at(-1).text;
  const titles = [...text.matchAll(/╭─ ([^ ]+)/g)].map(m => m[1]);
  assert.deepEqual(titles, ['bravo','charlie','delta','echo','zulu','alpha']);
});

test('extra source adapter reuse, URL fallback, account label and existing live-query behavior', async () => {
  const h = await createHarness({ config: JSON.stringify([{ id:'extra', reuseAdapter:'alpha', displayName:'Extra', baseUrl:' https://quota.example ' }]), configured: () => false, credential: () => ({ accountName:' Account ' }) });
  h.ctx.model.provider = 'extra';
  await h.command(); await h.command();
  assert.equal(h.state.calls.length, 2); // Extra sources intentionally bypass the built-in TTL.
  assert.equal(h.state.calls[0].id, 'alpha');
  assert.equal(h.state.calls[0].auth.model.baseUrl, 'https://quota.example');
  assert.equal(h.state.calls[0].auth.headers.Authorization, 'Bearer extra-key');
  assert.match(h.state.notifications.at(-1).text, /Account/);
  h.state.config = JSON.stringify([{ id:'extra', reuseAdapter:'alpha' }]);
  await h.command(); assert.equal(h.state.calls.at(-1).auth.model.baseUrl, 'https://provider.example');
  h.ctx.modelRegistry.getProvider = () => undefined;
  h.ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey:'extra-key', baseUrl:'https://auth.example' } });
  await h.command(); assert.equal(h.state.calls.at(-1).auth.model.baseUrl, 'https://auth.example');
  h.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured:false });
  await h.command(); assert.equal(h.state.calls.length, 4);
});

test('config warnings, missing authentication, unsupported providers and error panels match baseline', async () => {
  const h = await createHarness({ config: JSON.stringify([null,{}, {id:'missing'}, {id:'bad-name',reuseAdapter:'alpha',displayName:1}, {id:'bad-url',reuseAdapter:'alpha',baseUrl:1}, {id:'unknown',reuseAdapter:'nope'}, {id:'no-url',reuseAdapter:'alpha'}]) });
  h.ctx.model.provider = 'unsupported';
  h.ctx.modelRegistry.getProvider = () => undefined;
  h.ctx.modelRegistry.getProviderAuth = async () => undefined;
  h.state.resolveAuth = async () => undefined;
  await h.command();
  const expected = JSON.parse(await readFile(new URL('./fixtures/warnings.json', import.meta.url), 'utf8'));
  assert.equal(h.state.notifications.at(-1).text, expected);
  h.state.config = '{}'; await h.command(); assert.match(h.state.notifications.at(-1).text, /顶层应为数组/);
  h.state.config = '{'; await h.command(); assert.match(h.state.notifications.at(-1).text, /不是合法 JSON/);
});

test('status lifecycle: active-only refresh, timer reuse, stale retention, third failure clears, shutdown', async () => {
  const h = await createHarness({ adapters:[{id:'alpha',displayName:'Alpha'},{id:'beta',displayName:'Beta'}] });
  h.event('session_start'); await h.settle();
  assert.deepEqual(h.state.calls.map(c => c.id), ['alpha']);
  assert.match(h.state.statuses.at(-1).text, /color:warning\(42%\)/);
  h.event('agent_start'); await h.settle(); assert.equal(h.state.timers.length, 1);
  assert.equal(h.state.timers[0].ms, 300_000); assert.equal(h.state.timers[0].unreferenced, true);
  h.state.query = async () => { throw new Error('offline'); };
  for (let i=1;i<=3;i++) {
    h.state.now += 60_000; h.state.timers[0].fn(); await h.settle();
    if (i<3) assert.match(h.state.statuses.at(-1).text, /stale/);
    else assert.equal(h.state.statuses.at(-1).text, undefined);
  }
  h.ctx.model.provider = 'unsupported'; h.event('model_select', {model:h.ctx.model}); await h.settle();
  assert.equal(h.state.statuses.at(-1).text, undefined);
  h.event('session_shutdown'); assert.equal(h.state.timers[0].cleared, true);
});

test('theme method binding, theme failures and missing status API degrade safely', async () => {
  const h = await createHarness(); await h.command();
  assert.match(h.state.statuses.at(-1).text, /color:warning/);
  h.ctx.ui.theme.fg = () => { throw new Error('theme unavailable'); };
  await h.command(); assert.equal(h.state.statuses.at(-1).text, '42%·5h 87%·7d');
  h.ctx.ui.setStatus = () => { throw new Error('no status API'); };
  await assert.doesNotReject(h.command());
});

test('credential and session guards still reject in-flight invalidation', async () => {
  for (const change of ['session','model','fingerprint','extra-key']) {
    const h = await createHarness(change === 'extra-key' ? { config: JSON.stringify([{id:'extra',reuseAdapter:'alpha'}]), configured: () => false } : {});
    h.state.query = async (_adapter,_auth,_signal,_timeout,guard) => {
      if (change === 'session') h.ctx.sessionManager.getSessionId = () => 'other-session';
      if (change === 'model') h.ctx.model = {provider:'alpha',id:'other-model'};
      if (change === 'fingerprint') h.state.resolveAuth = async () => ({fingerprint:'changed'});
      if (change === 'extra-key') h.ctx.modelRegistry.getProviderAuth = async () => ({auth:{apiKey:'changed'}});
      await guard(); return report();
    };
    await h.command(); assert.match(h.state.notifications.at(-1).text, /aborted/);
  }
});

test('rich dashboard output and interactive render cache match baseline', async () => {
  const h = await createHarness({ query: async () => report('alpha', {
    accountLabel: '示例账号', notes: ['note'], buckets: [
      ...report().buckets,
      {label:'requests',used:1200,limit:2000,resetsAt:1_800_003_600},
      {label:'余额',remaining:1.239,unit:'usd'}, {label:'用量',used:2,unit:'cny'}, {label:'未知'},
    ], metrics:[{label:'tokens',value:1_234_567},{label:'rate',value:12.345,unit:'percent'},{label:'标签',value:null}],
  }) });
  await h.command();
  const expected = JSON.parse(await readFile(new URL('./fixtures/dashboard.json', import.meta.url), 'utf8'));
  assert.equal(h.state.notifications.at(-1).text, expected);
  h.ctx.hasUI = true;
  h.ctx.ui.custom = async factory => {
    let closed = false;
    const component = factory({}, h.ctx.ui.theme, {}, () => {closed = true;});
    const first = component.render(72);
    assert.strictEqual(component.render(72), first);
    component.invalidate(); assert.notStrictEqual(component.render(72), first);
    assert.notDeepEqual(plain(component.render(40)), plain(first));
    component.handleInput('x'); assert.equal(closed,true);
    assert.match(first.at(-1), /按任意键关闭/);
  };
  await h.command();
  // handler catches UI errors and reports them via notify, so also check that no
  // assertion inside the custom component was swallowed by that boundary.
  assert.equal(h.state.notifications.length, 1);
});
