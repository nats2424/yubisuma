import { describe, expect, it } from 'vitest';
import type { Link } from '../lib/transport';
import { SIM_CONNECT_MS, SimNetwork } from './sim/network';

// 疑似ネットワーク自体の自己テスト（B-11）。ここが決定的でないと上のテストがすべて信用できない
const open = (net: SimNetwork, id: string, received: unknown[], cond = {}) => {
  const node = net.node(id, cond);
  const state = { opened: 0, downs: [] as string[] };
  const link: Link = node.linkFactory('ROOM', {
    onOpen: () => state.opened++,
    onDown: (r) => state.downs.push(r),
    onMessage: (m) => received.push(m),
  });
  return { node, link, state };
};

const scenario = (seed: number) => {
  const net = new SimNetwork({ seed });
  const got: unknown[] = [];
  const a = open(net, 'a', [], { jitterMs: 300, lossRate: 0.3 });
  open(net, 'b', got);
  open(net, 'c', []);
  net.clock.advance(SIM_CONNECT_MS);
  for (let i = 0; i < 50; i++) {
    a.link.send({ i });
    net.clock.advance(17);
  }
  net.clock.advance(1000);
  return { log: net.log, got };
};

describe('SimNetwork', () => {
  it('同じシードなら送信ログと受信順が毎回同じ', () => {
    const x = scenario(42);
    const y = scenario(42);
    expect(x.log).toEqual(y.log);
    expect(x.got).toEqual(y.got);
    // 別のシードなら欠落・順序が変わる（乱数が実際に効いている）
    expect(scenario(7).got).not.toEqual(x.got);
  });

  it('欠落率 0 なら全部届く（自分には届かない）', () => {
    const net = new SimNetwork({ seed: 1 });
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    const a = open(net, 'a', gotA);
    open(net, 'b', gotB);
    net.clock.advance(SIM_CONNECT_MS);
    for (let i = 0; i < 20; i++) a.link.send({ i });
    net.clock.advance(100);
    expect(gotB).toHaveLength(20);
    expect(gotA).toHaveLength(0);
    expect(net.log).toHaveLength(20);
  });

  it('送信時に JSON で複製される（参照を共有しない）', () => {
    const net = new SimNetwork();
    const got: unknown[] = [];
    const a = open(net, 'a', []);
    open(net, 'b', got);
    net.clock.advance(SIM_CONNECT_MS);
    const msg = { list: [1] };
    a.link.send(msg);
    msg.list.push(2);
    net.clock.advance(100);
    expect(got).toEqual([{ list: [1] }]);
  });

  it('freeze 中のタイマーは thaw まで動かず、送受信は落ちる', () => {
    const net = new SimNetwork();
    const got: unknown[] = [];
    const a = open(net, 'a', []);
    const b = open(net, 'b', got);
    net.clock.advance(SIM_CONNECT_MS);
    const clock = b.node.clockFor();
    let fired = 0;
    clock.setTimeout(() => fired++, 100);
    b.node.freeze();
    a.link.send({ x: 1 });
    net.clock.advance(1000);
    expect(fired).toBe(0);
    expect(got).toHaveLength(0);
    b.node.thaw();
    expect(fired).toBe(1);
    a.link.send({ x: 2 });
    net.clock.advance(100);
    expect(got).toEqual([{ x: 2 }]);
  });

  it('dropWhere は指定件数だけ落とす', () => {
    const net = new SimNetwork();
    const got: unknown[] = [];
    const a = open(net, 'a', []);
    open(net, 'b', got);
    net.clock.advance(SIM_CONNECT_MS);
    net.dropWhere((m) => (m as { i: number }).i % 2 === 0, 2);
    for (let i = 0; i < 6; i++) a.link.send({ i });
    net.clock.advance(100);
    expect(got).toEqual([{ i: 1 }, { i: 3 }, { i: 4 }, { i: 5 }]);
  });

  it('failConnects / disconnect / restore', () => {
    const net = new SimNetwork();
    const got: unknown[] = [];
    const a = open(net, 'a', []);
    a.node.failConnects(1);
    const b = open(net, 'b', got);
    net.clock.advance(SIM_CONNECT_MS);
    expect(a.state.downs).toEqual(['CHANNEL_ERROR']);
    expect(a.state.opened).toBe(0);
    expect(b.state.opened).toBe(1);
    b.node.disconnect();
    expect(b.state.downs).toEqual(['CHANNEL_ERROR']);
    b.node.restore();
    expect(b.state.opened).toBe(2);
  });

  it('runUntil は上限時間で打ち切る', () => {
    const net = new SimNetwork();
    expect(net.clock.runUntil(() => false, 500)).toBe(false);
    expect(net.clock.now()).toBe(500);
    expect(net.clock.runUntil(() => net.clock.now() >= 700, 500)).toBe(true);
  });
});
