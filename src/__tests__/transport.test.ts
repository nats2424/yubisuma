import { describe, expect, it } from 'vitest';
import {
  CONNECT_TIMEOUT_MS,
  createManagedTransport,
  isOnlineMode,
  REBUILD_AFTER_MS,
  RETRY_DELAYS_MS,
  type ConnectionStatus,
  type Transport,
} from '../lib/transport';
import { SIM_CONNECT_MS, SimNetwork, type SimNode } from './sim/network';

const setup = (configure?: (n: SimNode) => void) => {
  const net = new SimNetwork({ seed: 1 });
  const node = net.node('a');
  const peer = net.node('b');
  configure?.(node);
  const t = createManagedTransport(node.linkFactory, 'ROOM', node.clockFor());
  const statuses: ConnectionStatus[] = [t.status];
  t.onStatus((s) => statuses.push(s));
  const peerT = createManagedTransport(peer.linkFactory, 'ROOM', peer.clockFor());
  const got: unknown[] = [];
  peerT.onMessage((m) => got.push(m));
  return { net, node, t, statuses, peerT, got };
};

const settle = (net: SimNetwork, t: Transport, want: ConnectionStatus, maxMs = 60000) =>
  net.clock.runUntil(() => t.status === want, maxMs);

describe('ManagedTransport', () => {
  it('isOnlineMode を公開している（テスト環境では Supabase 未設定）', () => {
    expect(isOnlineMode).toBe(false);
  });

  it('接続できたら connected になり、送受信できる', () => {
    const { net, t, statuses, got } = setup();
    expect(t.status).toBe('connecting');
    // connected 前は送らない
    expect(t.send({ early: true })).toBe(false);
    net.clock.advance(SIM_CONNECT_MS);
    expect(statuses).toEqual(['connecting', 'connected']);
    expect(t.send({ x: 1 })).toBe(true);
    net.clock.advance(100);
    expect(got).toEqual([{ x: 1 }]);
  });

  it('AC-05: 初回接続が 2 回失敗し 3 回目で成功したら、failed を経ずに connected になる', () => {
    const { net, t, statuses } = setup((n) => n.failConnects(2));
    expect(settle(net, t, 'connected')).toBe(true);
    expect(statuses).toEqual(['connecting', 'connected']);
    // 1 回目失敗 → 1 秒待ち → 2 回目失敗 → 2 秒待ち → 3 回目成功
    expect(net.clock.now()).toBeLessThanOrEqual(SIM_CONNECT_MS * 3 + RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1] + 10);
  });

  it('AC-06: リトライ上限まで失敗したら failed、reconnect() で（作り直しなしに）接続し直せる', () => {
    const { net, t, statuses } = setup((n) => n.failConnects(4));
    expect(settle(net, t, 'failed')).toBe(true);
    expect(statuses).toEqual(['connecting', 'failed']);
    // failed のまま勝手に再試行しない
    net.clock.advance(30000);
    expect(t.status).toBe('failed');
    t.reconnect();
    expect(t.status).toBe('connecting');
    expect(settle(net, t, 'connected')).toBe(true);
  });

  it('応答のない接続試行は CONNECT_TIMEOUT_MS で失敗扱いにして再試行する', () => {
    // ネットワークが落ちていると試行は応答しない
    const { net, node, t } = setup((n) => n.disconnect());
    net.clock.advance(CONNECT_TIMEOUT_MS + 10);
    expect(t.status).toBe('connecting');
    node.restore();
    expect(settle(net, t, 'connected')).toBe(true);
  });

  it('AC-07: 接続後に切断されると reconnecting、復帰すると connected。一度つながったら failed にしない', () => {
    const { net, node, t, statuses } = setup();
    net.clock.advance(SIM_CONNECT_MS);
    node.disconnect();
    expect(t.status).toBe('reconnecting');
    expect(t.send({ x: 1 })).toBe(false);
    // 長く戻らなくても failed にはならない（Link を作り直しながら待ち続ける）
    net.clock.advance(REBUILD_AFTER_MS * 5);
    expect(t.status).toBe('reconnecting');
    node.restore();
    expect(t.status).toBe('connected');
    expect(statuses).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
  });

  it('reconnecting が続くと Link を作り直し、新しい Link で戻れる', () => {
    const { net, node, t, got } = setup();
    net.clock.advance(SIM_CONNECT_MS);
    node.disconnect();
    net.clock.advance(REBUILD_AFTER_MS + SIM_CONNECT_MS);
    node.restore();
    expect(t.status).toBe('connected');
    expect(t.send({ after: true })).toBe(true);
    net.clock.advance(100);
    // 古い Link と新しい Link の両方から二重に届かない
    expect(got).toEqual([{ after: true }]);
  });

  it('setNetworkOnline(false) で reconnecting、true で張り直す', () => {
    const { net, t } = setup();
    net.clock.advance(SIM_CONNECT_MS);
    t.setNetworkOnline(false);
    expect(t.status).toBe('reconnecting');
    t.setNetworkOnline(true);
    expect(settle(net, t, 'connected', 1000)).toBe(true);
  });

  it('close 後は通知も送信もしない', () => {
    const { net, t, statuses } = setup();
    t.close();
    net.clock.advance(1000);
    expect(statuses).toEqual(['connecting']);
    expect(t.send({ x: 1 })).toBe(false);
  });
});
