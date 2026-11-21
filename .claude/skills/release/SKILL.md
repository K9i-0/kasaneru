---
name: release
description: kasaneru のリリース（バージョンbump + CHANGELOG + タグ → GH Actions で npm publish と GitHub Release）
allowed-tools: Bash(git:*), Bash(grep:*), Bash(npm test), Bash(npm pack:*), Bash(gh run:*), Read, Edit, AskUserQuestion
---

# kasaneru リリース

タグ `vX.Y.Z` を push すると、GH Actions (`.github/workflows/release.yml`) が
macOS でテスト → npm publish（OIDC Trusted Publishing、トークン不要）→ GitHub Release 作成まで行う。

## 前提

- main ブランチで作業中であること
- 未コミットの変更がないこと

指定済みのバージョンを優先する。未指定なら以下の既定ルールで決定し、決定内容と理由を報告して進める。
リリース依頼に含まれるコミット・push・タグ作成に追加の承認を求めない。

## 手順

### 1. 現在のバージョンと差分の確認

```bash
grep '"version"' package.json
git tag -l 'v*' --sort=-v:refname | head -1
git log $(git tag -l 'v*' --sort=-v:refname | head -1)..HEAD --oneline
```

タグがまだ無い場合は全履歴が対象。

### 2. バージョンを決定

- 破壊的変更（manifest のキーや CLI オプションの削除・意味変更、出力の互換性破壊）→ `major`。
  0.x の間は `minor` に読み替える。未承認なら影響を示してユーザーに確認する。
- 新機能 → `minor`（0.x の間は `patch` でもよい）
- 修正・改善・保守 → `patch`

### 3. CHANGELOG 更新

`CHANGELOG.md` の先頭（説明文の直後）に追加する。英語で書く。空のセクションは省略する。

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
### Changed
### Fixed
```

見出しの `## [X.Y.Z]` は release.yml が Release ノートを抜き出す目印なので形式を変えない。

### 4. バージョン bump

`package.json` と `package-lock.json`（先頭の2箇所）の `version` を更新する。
`flutter_backend/pubspec.yaml` の `version` も同じ値に揃える。

### 5. ローカル検証

**すべて pass しなければ次に進まない。**

```bash
npm test
npm pack --dry-run   # 配信物に余計なファイルが無いこと、CHANGELOG.md が入っていること
```

ffmpeg と Google Chrome が必要。失敗が今回の変更に起因するなら修正して再検証する。
自力で解消できない障害が残る場合は内容を報告し、タグを push しない。

### 6. コミット & タグ

```bash
git add package.json package-lock.json flutter_backend/pubspec.yaml CHANGELOG.md
git commit -m "Release vX.Y.Z"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

タグ名と `package.json` の version が一致しないとワークフローが止まる。

### 7. 完了確認

```bash
gh run list --workflow=release.yml --limit 1
gh run watch <run-id> --exit-status
npm view kasaneru version
```

publish が `ENEEDAUTH` で失敗する場合は、npmjs.com の kasaneru → Settings → Trusted publishing の設定
（user `K9i-0` / repository `kasaneru` / workflow `release.yml`）を確認する。
