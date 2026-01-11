# 動画・音声分割ツール

ブラウザ完結型の動画/音声トリミングアプリケーション。サーバーへのアップロード不要で、プライバシーを保護しながら動画の切り出しが可能です。

## ✨ 特徴

- **完全ローカル処理**: ファイルは一切サーバーにアップロードされません
- **高速変換**: libx264 ultrafast プリセットによる高速エンコード
- **直感的UI**: スライダーで開始/終了点を簡単に指定
- **幅広い対応**: 動画・音声ファイル全般に対応 (最大1GB)

## 🛠 技術スタック

| 技術 | バージョン | 用途 |
|------|-----------|------|
| React | 19.x | UIフレームワーク |
| Vite | 7.x | ビルドツール |
| FFmpeg.wasm | 0.11.x | 動画処理エンジン |
| Tailwind CSS | 4.x | スタイリング |
| TypeScript | 5.x | 型安全性 |

### なぜ FFmpeg.wasm v0.11.x を使用するか

v0.12.x はマルチスレッド対応ですが、一部の環境でWeb Workerがフリーズする既知の問題があります。v0.11.x はシングルスレッドですが安定性が高く、本アプリケーションの用途に適しています。

## 🚀 セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. FFmpeg コアファイルの配置

`public/` フォルダに以下の3ファイルを配置する必要があります：

```
public/
├── ffmpeg-core.js
├── ffmpeg-core.wasm
└── ffmpeg-core.worker.js  ← 重要: 手動でダウンロードが必要
```

**ダウンロード方法:**

```bash
cd public
# PowerShell
Invoke-WebRequest -Uri "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js" -OutFile "ffmpeg-core.js"
Invoke-WebRequest -Uri "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.wasm" -OutFile "ffmpeg-core.wasm"
Invoke-WebRequest -Uri "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.worker.js" -OutFile "ffmpeg-core.worker.js"
```

### 3. 開発サーバー起動

```bash
npm run dev
```

## 🌐 デプロイ (Vercel)

### 必須設定: COOP/COEP ヘッダー

FFmpeg.wasm は `SharedArrayBuffer` を使用するため、以下のHTTPヘッダーが必須です。

プロジェクトルートに `vercel.json` を作成（既に作成済み）:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

### デプロイ手順

1. GitHubにプッシュ
2. Vercelでリポジトリをインポート
3. 自動デプロイ完了

## 📁 プロジェクト構成

```
├── public/
│   ├── ffmpeg-core.js      # FFmpeg コア (手動配置)
│   ├── ffmpeg-core.wasm    # WebAssembly バイナリ (手動配置)
│   └── ffmpeg-core.worker.js # Web Worker (手動配置)
├── src/
│   ├── App.tsx             # メインアプリケーション
│   ├── main.tsx            # エントリーポイント
│   └── index.css           # スタイル
├── vercel.json             # Vercel 設定 (COOP/COEP ヘッダー)
├── vite.config.ts          # Vite 設定
└── package.json
```

## ⚠️ 既知の制限事項

- **ファイルサイズ**: 1GB以上のファイルはメモリ制限により処理できません
- **ブラウザ互換性**: SharedArrayBuffer対応ブラウザ (Chrome, Firefox, Edge) が必要
- **出力形式**: 安定性のため、常にMP4形式で出力されます

## 📄 ライセンス

MIT License
