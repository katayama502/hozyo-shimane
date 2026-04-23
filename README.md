# HojoSearch 島根版 🏛

> 島根県の補助金・助成金をAIで検索できる超軽量サービス
> DB不要・バックエンド不要・GitHub Pages無料ホスティング

## MVP v2.0 概要

| 項目 | 内容 |
|---|---|
| ホスティング | GitHub Pages（無料） |
| AIエンジン | Gemini API (gemini-1.5-flash) |
| バックエンド | なし（サーバーレス） |
| データベース | なし（Geminiが生きたDBとして機能） |
| 全ファイルサイズ | 約77KB |

## 機能一覧

- **補助金一覧表示** — ページロード時にGemini APIから島根県の補助金を自動取得
- **スケルトンUI** — 取得中はアニメーション付きスケルトン表示
- **フィルタリング** — カテゴリ・発行元・ステータスで絞り込み
- **キーワード検索** — 複数キーワード対応のリアルタイム検索
- **並び替え** — 締切順・金額順
- **詳細モーダル** — 申請条件・対象者・公式URLを表示
- **AI逆引き検索** — 「やりたいこと」を入力するとGeminiが最適な補助金を提案
- **締切バッジ** — 残14日以内（赤）・30日以内（黄）で色分け
- **セッションキャッシュ** — 同一セッション30分間はAPI再呼び出しを防止

## セットアップ

### 1. Gemini APIキーの取得

1. [Google AI Studio](https://aistudio.google.com/app/apikey) にアクセス
2. 「Get API key」→「Create API key」をクリック
3. 生成されたキー（`AIzaSy...`）をコピー

### 2. ローカルで起動

```bash
# HTTPサーバーが必要（直接ファイルを開くとCORSエラーが出る場合があります）
python3 -m http.server 8080
# http://localhost:8080 を開く
```

### 3. APIキーの設定

- 右上の「⚙ APIキー設定」をクリック
- 取得したGemini APIキーを入力して「保存して補助金を取得する」

> **注意**: APIキーはお使いのブラウザのlocalStorageにのみ保存されます。  
> コードベースやサーバーには一切送信・保存されません。

## GitHub Pagesへのデプロイ

1. このリポジトリをGitHubにpush
2. Settings → Pages → Source: `main` ブランチ、`/ (root)` を選択
3. 表示されたURLにアクセス

```
https://{username}.github.io/{repository-name}/
```

## ファイル構成

```
.
├── index.html    # メインHTML（UIの骨格・タブ・モーダル）
├── style.css     # スタイル（レスポンシブ・カード・バッジ）
├── app.js        # メインロジック（状態管理・イベント）
├── gemini.js     # Gemini API呼び出しモジュール
├── ui.js         # DOM操作・カード描画・モーダル
├── filter.js     # フィルタリング・ソート・キーワード検索
├── prompts.js    # Geminiプロンプト定義
└── .gitignore    # APIキー等の漏洩防止設定
```

## 技術スタック

- **フロントエンド**: バニラJS（ライブラリ・フレームワーク不使用）
- **AIエンジン**: Gemini API `gemini-1.5-flash`（無料枠: 1,500クエリ/日）
- **ホスティング**: GitHub Pages
- **データ保存**: localStorage（APIキーのみ）

## Gemini API設定

| 設定 | 値 |
|---|---|
| モデル | gemini-1.5-flash |
| temperature | 0.1（JSON出力安定化） |
| maxOutputTokens | 8192 |
| responseMimeType | application/json |

## セキュリティ

- APIキーはlocalStorageに保存（絶対にコードにハードコードしないこと）
- XSS対策: 全動的データはtextContent/DOM APIで設定（innerHTML不使用）
- `.gitignore`で `.env`ファイル等の誤コミットを防止

## 免責事項

本サービスはGoogle Gemini AIによる情報提供です。補助金情報の正確性・最新性は保証されません。
申請前に必ず**公式サイト・担当窓口**にてご確認ください。

---

**HojoSearch 島根版 MVP v2.0**  
© 2026 AIエージェントチーム
