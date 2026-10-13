// 紛らわしい文字（0/O, 1/I/L）を除いたルームコード用文字
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

export const generateRoomCode = (): string =>
  Array.from({ length: ROOM_CODE_LENGTH }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export const normalizeRoomCode = (input: string): string =>
  input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);

const safeGet = (storage: () => Storage, key: string): string | null => {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
};
const safeSet = (storage: () => Storage, key: string, value: string) => {
  try {
    storage().setItem(key, value);
  } catch {
    // プライベートモード等で保存できなくても動作は継続
  }
};

// プレイヤーIDはタブごと（sessionStorage）。リロードしても同じ人として復帰できる。
export const getPlayerId = (): string => {
  let id = safeGet(() => sessionStorage, 'sukima:playerId');
  if (!id) {
    id = 'p_' + Math.random().toString(36).slice(2, 10);
    safeSet(() => sessionStorage, 'sukima:playerId', id);
  }
  return id;
};

export const NAME_MAX = 10;
export const getSavedName = (): string => safeGet(() => localStorage, 'sukima:name') ?? '';
export const saveName = (name: string) => safeSet(() => localStorage, 'sukima:name', name);
