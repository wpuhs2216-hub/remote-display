# remote-display

登録した画像とテキストを遠隔で出力するシンプルな Web アプリ。

## 🔗 公開URL（本番）

| 画面 | URL |
|---|---|
| 📱 操作画面 | **https://remote-display.wpuhs2216.workers.dev/control** |
| 🖥 出力画面 | **https://remote-display.wpuhs2216.workers.dev/display** |

出力画面はダブルタップで全画面表示。操作には合言葉が必要です。

- **操作画面** `/control` — 画像+テキストのプリセット登録・編集・削除、「表示」ボタンで出力側に反映、表示クリア
- **出力画面** `/display` — 全画面で上に画像・下にテキストを表示。2秒ポーリングで自動更新、ダブルタップでフルスクリーン
- スマホ・タブレット対応（レスポンシブ）

## 構成

| ファイル | 役割 |
|---|---|
| `src/worker.js` | Cloudflare Workers 版バックエンド（KV に画像・プリセットを保存） |
| `server.js` | ローカル/LAN 用 Node.js サーバ（`data/` にファイル保存） |
| `public/` | フロントエンド（両バックエンド共通） |

## ローカル実行

```bash
npm install
npm start          # Node版: http://localhost:3800
npm run dev        # Workers版(ローカルKVエミュレーション): http://localhost:8787
```

## Cloudflare Workers へのデプロイ

```bash
npx wrangler login
npx wrangler kv namespace create KV   # 出力された id を wrangler.toml に設定
npx wrangler secret put ADMIN_KEY     # 操作画面用の合言葉
npm run deploy
```

## 認証

`ADMIN_KEY`（Workers シークレット / 環境変数）を設定すると、書き込み系 API に
`X-Admin-Key` ヘッダが必須になります。操作画面では初回に合言葉の入力を求められ、
localStorage に保存されます。閲覧（出力画面）は認証不要です。
