#!/usr/bin/env python3
"""ロールの担当範囲の外を変更していないか確かめる。

使い方:
  python3 .claude/scripts/check-scope.py <role> <base>..<head>
  例: python3 .claude/scripts/check-scope.py client 9494107..worktree-agent-xxxx

範囲外の変更があれば一覧を出して終了コード 1 を返す。
担当範囲は CLAUDE.md の「担当範囲」の表と .claude/agents/<role>.md に合わせること。
"""
import fnmatch
import subprocess
import sys

# fnmatch の * は / も含めて一致するので、"src/lib/*" はサブフォルダも含む
SCOPES = {
    "backend": [
        "src/lib/*", "src/room/*",
        "src/games/*.ts",
        "src/__tests__/*",
        "docs/dev/02-architecture.md",
        "docs/dev/04-qa-report.md", "docs/dev/05-security-report.md", "docs/dev/09-review.md",
    ],
    "client": [
        "src/components/*", "src/App.tsx", "src/main.tsx", "src/styles.css",
        "src/games/*.tsx",
        "index.html", "public/*", "README.md", "design/implemented/*",
        "docs/dev/04-qa-report.md", "docs/dev/05-security-report.md", "docs/dev/09-review.md",
    ],
    "qa": ["src/__tests__/qa-*.test.ts", "docs/dev/04-qa-report.md"],
    "security": ["src/__tests__/security-*.test.ts", "docs/dev/05-security-report.md"],
    "designer": ["design/*"],
    "pdm": [
        "docs/strategy/*-pdm-*.md",
        "docs/dev/01-pdm-spec.md", "docs/dev/06-target.md",
        "docs/dev/07-user-journey.md", "docs/dev/08-pmf-strategy.md",
    ],
    "cto": ["docs/dev/02-architecture.md", "docs/dev/11-launch-guide.md", "docs/strategy/*-cto-*.md"],
    "pjm": ["docs/dev/03-wbs.md", "docs/strategy/*-pjm-*.md"],
    "marketing": ["docs/dev/10-marketing-monetization.md", "docs/strategy/*-marketing-*.md"],
    "strategy-manager": ["docs/strategy/*-strategy-manager-*.md"],
    "sns-marketer": ["marketing/sns/*"],
    "reviewer": [],
}

# Backend の src/games は .ts だけ（.tsx は Client）
EXCLUDES = {
    "backend": ["src/games/*.tsx"],
    # 実装後のスクリーンショットは Client が撮る
    "designer": ["design/implemented/*"],
}


def in_scope(role: str, path: str) -> bool:
    if any(fnmatch.fnmatch(path, p) for p in EXCLUDES.get(role, [])):
        return False
    return any(fnmatch.fnmatch(path, p) for p in SCOPES[role])


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in SCOPES:
        print(__doc__.strip())
        print("ロール:", ", ".join(SCOPES))
        return 2
    role, rng = sys.argv[1], sys.argv[2]
    out = subprocess.run(
        ["git", "diff", "--name-only", rng], capture_output=True, text=True, check=True
    ).stdout.split()
    outside = [p for p in out if not in_scope(role, p)]
    print(f"{role}: 変更 {len(out)} ファイル / 範囲外 {len(outside)} ファイル")
    for p in outside:
        print("  範囲外:", p)
    return 1 if outside else 0


if __name__ == "__main__":
    sys.exit(main())
