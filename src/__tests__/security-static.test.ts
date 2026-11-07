// Security（S-03）：フロントエンドの XSS と秘密情報の静的チェック。
// ソースを文字列として読み、危険な API や秘密情報の混入がないことを回帰テストにする。
// （dist/ の中身と git の履歴は docs/dev/05-security-report.md にコマンドと結果を記録）
import { describe, expect, it } from 'vitest';
import envExample from '../../.env.example?raw';
import gitignore from '../../.gitignore?raw';

// テスト以外の製品コード（src 配下）
const sources = Object.entries(
  import.meta.glob<string>(['../**/*.{ts,tsx}', '!./**'], { query: '?raw', import: 'default', eager: true }),
);

const hits = (re: RegExp) => sources.filter(([, code]) => re.test(code)).map(([path]) => path);

describe('XSS（名前・チャット・ゲーム表示）', () => {
  it('製品コードを読み込めている', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.some(([p]) => p.endsWith('components/Chat.tsx'))).toBe(true);
    expect(sources.some(([p]) => p.includes('__tests__'))).toBe(false);
  });

  it('HTML を文字列から組み立てる API（dangerouslySetInnerHTML / innerHTML / insertAdjacentHTML / document.write）を使わない', () => {
    expect(hits(/dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/)).toEqual([]);
  });

  it('文字列をコードとして実行する API（eval / new Function / 文字列の setTimeout）を使わない', () => {
    expect(hits(/\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*['"`]/)).toEqual([]);
  });

  it('href / src に受信データを入れない（リンク先は固定の文字列だけ）', () => {
    expect(hits(/\b(href|src)=\{/)).toEqual([]);
  });
});

describe('秘密情報', () => {
  it('.env / .env*.local は .gitignore で除外されている', () => {
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain('.env');
    expect(lines).toContain('.env*.local');
  });

  it('.env.example には値が入っていない', () => {
    for (const line of envExample.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      expect(line).toMatch(/^[A-Z_]+=$/);
    }
  });

  it('クライアントが読む環境変数は Supabase の URL・anon キーと VITE_BASE だけ。service_role や JWT を直書きしない', () => {
    const envNames = new Set(sources.flatMap(([, code]) => [...code.matchAll(/import\.meta\.env\.(\w+)/g)].map((m) => m[1])));
    expect([...envNames].sort()).toEqual(['VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL']);
    expect(hits(/service_role|eyJhbGciOi|sb_secret_/)).toEqual([]);
  });
});
