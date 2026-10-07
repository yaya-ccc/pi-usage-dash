import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, report } from './harness.mjs';

const STALE_CTX = 'This extension ctx is stale after session replacement or reload.';

function revokeContext(ctx) {
  const reads = [];
  for (const key of ['ui', 'model', 'modelRegistry', 'sessionManager']) {
    Object.defineProperty(ctx, key, {
      configurable: true,
      get() { reads.push(key); throw new Error(STALE_CTX); },
    });
  }
  return reads;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const outcome of ['failure', 'success']) {
  test(`shutdown discards an in-flight ${outcome} without reading the replaced context`, async () => {
    const h = await createHarness();
    await h.command(); // Seed history: the crash happens in the stale-value fallback.
    h.state.now += 60_000;
    const pending = deferred();
    h.state.query = () => pending.promise;
    const refresh = h.status.refreshStatus(h.ctx);
    await h.settle();
    assert.equal(h.state.active, 1);

    h.event('session_shutdown');
    const reads = revokeContext(h.ctx);
    const statusCount = h.state.statuses.length;
    if (outcome === 'failure') pending.reject(new Error('offline'));
    else pending.resolve(report());

    await assert.doesNotReject(refresh, STALE_CTX);
    assert.deepEqual(reads, []);
    assert.equal(h.state.calls.at(-1).signal.aborted, true);
    assert.equal(h.state.statuses.length, statusCount);
  });

  test(`/usage quietly stops after shutdown during a pending ${outcome}`, async () => {
    const pending = deferred();
    const h = await createHarness({ query: () => pending.promise });
    const command = h.command();
    await h.settle();
    assert.equal(h.state.active, 1);
    h.event('session_shutdown');
    const reads = revokeContext(h.ctx);
    if (outcome === 'failure') pending.reject(new Error('offline'));
    else pending.resolve(report());
    await assert.doesNotReject(command);
    assert.deepEqual(reads, []);
    assert.equal(h.state.notifications.length, 0);
    assert.equal(h.state.statuses.length, 0);
  });
}

test('auth resolution finishing after shutdown cannot read the old session or model', async () => {
  const auth = deferred();
  const h = await createHarness({ resolveAuth: () => auth.promise });
  const command = h.command();
  await h.settle();
  h.event('session_shutdown');
  const reads = revokeContext(h.ctx);
  auth.resolve({ fingerprint: 'fingerprint', secrets: [] });
  await assert.doesNotReject(command);
  assert.deepEqual(reads, []);
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.state.notifications.length, 0);
});

for (const phase of ['baseUrl', 'credential']) {
  test(`extra-source ${phase} lookup respects shutdown while awaiting auth`, async () => {
    const auth = deferred();
    const h = await createHarness({
      config: JSON.stringify([{ id: 'extra', reuseAdapter: 'alpha', ...(phase === 'credential' ? { baseUrl: 'https://quota.example' } : {}) }]),
      configured: () => false,
    });
    h.ctx.model.provider = 'extra';
    h.ctx.modelRegistry.getProvider = () => undefined;
    h.ctx.modelRegistry.getProviderAuth = () => auth.promise;
    const command = h.command();
    await h.settle();
    h.event('session_shutdown');
    const reads = revokeContext(h.ctx);
    auth.resolve({ auth: { apiKey: 'extra-key', baseUrl: 'https://quota.example' } });
    await assert.doesNotReject(command);
    assert.deepEqual(reads, []);
    assert.equal(h.state.calls.length, 0);
    assert.equal(h.state.notifications.length, 0);
  });
}

test('timer uses the latest event context and a stopped callback does nothing', async () => {
  const h = await createHarness({ adapters: [{ id: 'alpha', displayName: 'Alpha' }, { id: 'beta', displayName: 'Beta' }] });
  h.event('session_start');
  await h.settle();
  const fresh = { ...h.ctx, model: { provider: 'beta', id: 'other-model' } };
  const reads = revokeContext(h.ctx);
  h.event('agent_start', {}, fresh);
  await h.settle();
  assert.equal(h.state.timers.length, 1);
  h.state.now += 60_000;
  h.state.timers[0].fn();
  await h.settle();
  assert.deepEqual(reads, []);
  assert.deepEqual(h.state.calls.map(c => c.id), ['alpha', 'beta', 'beta']);

  h.event('session_shutdown', {}, fresh);
  const freshReads = revokeContext(fresh);
  h.state.timers[0].fn();
  await h.settle();
  assert.deepEqual(freshReads, []);
});

test('session replacement resets history and an old result cannot overwrite the new session', async () => {
  const h = await createHarness();
  await h.command();
  const fresh = { ...h.ctx, sessionManager: { getSessionId: () => 'new-session' } };
  h.state.now += 60_000;
  const pending = deferred();
  h.state.query = () => pending.promise;
  const oldRefresh = h.status.refreshStatus(h.ctx);
  await h.settle();
  h.event('session_shutdown');
  const reads = revokeContext(h.ctx);
  h.state.query = async () => { throw new Error('new session offline'); };
  h.event('session_start', {}, fresh);
  await h.settle();
  assert.equal(h.state.statuses.at(-1).text, undefined); // No stale history from the old session.
  const statusCount = h.state.statuses.length;
  pending.resolve(report());
  await assert.doesNotReject(oldRefresh);
  assert.deepEqual(reads, []);
  assert.equal(h.state.statuses.length, statusCount);
  h.event('session_shutdown', {}, fresh);
});

test('model switch discards both late successes and late failures', async () => {
  for (const outcome of ['success', 'failure']) {
    const pending = deferred();
    const h = await createHarness({ adapters: [{ id: 'alpha', displayName: 'Alpha' }, { id: 'beta', displayName: 'Beta' }] });
    h.state.query = adapter => adapter.id === 'alpha' ? pending.promise : Promise.resolve(report('beta'));
    const oldRefresh = h.status.refreshStatus(h.ctx);
    await h.settle();
    h.ctx.model = { provider: 'beta', id: 'new-model' };
    h.event('model_select', { model: h.ctx.model });
    await h.settle();
    const statuses = [...h.state.statuses];
    if (outcome === 'success') pending.resolve(report());
    else pending.reject(new Error('offline'));
    await assert.doesNotReject(oldRefresh);
    assert.deepEqual(h.state.statuses, statuses);
  }
});

test('newer refresh wins when requests finish out of order', async () => {
  const pending = deferred();
  const h = await createHarness({ query: () => pending.promise });
  const oldRefresh = h.status.refreshStatus(h.ctx);
  await h.settle();
  h.state.query = async () => report('alpha', { buckets: [{ id: 'five-hour', remaining: 90, limit: 100 }] });
  await h.status.refreshStatus(h.ctx);
  assert.match(h.state.statuses.at(-1).text, /90%/);
  const statusCount = h.state.statuses.length;
  pending.resolve(report());
  await oldRefresh;
  assert.equal(h.state.statuses.length, statusCount);
});

test('theme getter failures degrade to plain text and already-stale refreshes do not reject', async () => {
  const h = await createHarness();
  Object.defineProperty(h.ctx.ui, 'theme', { get() { throw new Error('theme unavailable'); } });
  await h.command();
  assert.equal(h.state.statuses.at(-1).text, '42%·5h 87%·7d');
  assert.ok(!h.state.notifications.at(-1).text.includes('/usage 失败'));
  const reads = revokeContext(h.ctx);
  await assert.doesNotReject(h.status.refreshStatus(h.ctx));
  assert.deepEqual(reads, ['model']);
});

test('shutdown cancels the worker pool before queued providers launch', async () => {
  const pending = deferred();
  const h = await createHarness({
    adapters: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(id => ({ id, displayName: id })),
    query: () => pending.promise,
  });
  const command = h.command();
  await h.settle();
  assert.equal(h.state.calls.length, 4);
  h.event('session_shutdown');
  const reads = revokeContext(h.ctx);
  pending.resolve(report());
  await assert.doesNotReject(command);
  assert.deepEqual(reads, []);
  assert.equal(h.state.calls.length, 4);
  assert.ok(h.state.calls.every(c => c.signal.aborted));
});

test('a stale-context worker failure also cancels sibling requests', async () => {
  const pending = deferred();
  const h = await createHarness({
    adapters: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(id => ({ id, displayName: id })),
    query: adapter => {
      if (adapter.id === 'alpha') throw new Error(STALE_CTX);
      return pending.promise;
    },
  });
  await h.command();
  assert.equal(h.state.calls.length, 4);
  assert.ok(h.state.calls.every(c => c.signal.aborted));
  const reads = revokeContext(h.ctx);
  pending.resolve(report());
  await h.settle();
  assert.deepEqual(reads, []);
  assert.equal(h.state.calls.length, 4);
  assert.equal(h.state.notifications.length, 0);
});
