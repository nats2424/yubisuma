import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

// ルーム内の全員にメッセージを配るだけの最小インターフェース。
// 自分が送ったメッセージは自分には届かない。
export interface Transport {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  // 接続が確立したら resolve
  ready: Promise<void>;
  close(): void;
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isOnlineMode = Boolean(supabaseUrl && supabaseKey);

let client: SupabaseClient | null = null;
const getClient = () => {
  if (!client) {
    client = createClient(supabaseUrl!, supabaseKey!, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
  }
  return client;
};

// Supabase Realtime の Broadcast を使う（DBテーブル不要）
class SupabaseTransport implements Transport {
  private channel: RealtimeChannel;
  private listeners: ((msg: unknown) => void)[] = [];
  ready: Promise<void>;

  constructor(roomCode: string) {
    const supabase = getClient();
    this.channel = supabase.channel(`sukima:${roomCode}`, {
      config: { broadcast: { self: false, ack: false } },
    });
    this.channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      this.listeners.forEach((cb) => cb(payload));
    });
    this.ready = new Promise((resolve, reject) => {
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status));
      });
    });
  }

  send(msg: unknown) {
    void this.channel.send({ type: 'broadcast', event: 'msg', payload: msg });
  }

  onMessage(cb: (msg: unknown) => void) {
    this.listeners.push(cb);
  }

  close() {
    void getClient().removeChannel(this.channel);
  }
}

// Supabase未設定時のデモ用：同じブラウザのタブ間で BroadcastChannel を使う
class LocalTransport implements Transport {
  private bc: BroadcastChannel;
  private listeners: ((msg: unknown) => void)[] = [];
  ready = Promise.resolve();

  constructor(roomCode: string) {
    this.bc = new BroadcastChannel(`sukima:${roomCode}`);
    this.bc.onmessage = (e) => this.listeners.forEach((cb) => cb(e.data));
  }

  send(msg: unknown) {
    this.bc.postMessage(msg);
  }

  onMessage(cb: (msg: unknown) => void) {
    this.listeners.push(cb);
  }

  close() {
    this.bc.close();
  }
}

export const createTransport = (roomCode: string): Transport =>
  isOnlineMode ? new SupabaseTransport(roomCode) : new LocalTransport(roomCode);
