# Simulated 検証手順（実機を買う前に Pixel だけで end-to-end 確認）

目的：**Mentra Live を買う前**に、母艦スマホ（Pixel 9 Pro Fold）の MentraOS アプリ＋
Simulated Glasses モードで「音声 I/O が成立するか（特に **TTS が鳴るか**）」をタダで潰す。

ここが通れば、残る実機リスクは「画面を撮った写真の文字が読めるか」「実機ボタン」「装着感・電池」
くらいまで縮む。

---

## 0. 用意するもの
- Pixel（母艦）に **MentraOS アプリ**をインストール
- このリポジトリを動かす PC（Node 20+）＋ **ngrok**
- 推論バックエンド：`VISION_BACKEND=direct`（`ANTHROPIC_API_KEY` だけで動く・FastAPI 不要）が一番ラク

## 1. アプリ登録（console.mentraglass.com）
- スマホアプリと**同じアカウント**でログイン → Create App
- Package name を `.env` の `PACKAGE_NAME` と**完全一致**
- Public URL = ngrok の URL（末尾スラッシュ無し）
- Permissions に **MICROPHONE**（＋ 後の撮影確認をするなら CAMERA）
- API key を発行 → `.env` の `MENTRAOS_API_KEY` へ

## 2. .env（direct モード最小）
```
PACKAGE_NAME=com.mattyopon.awsquiz
MENTRAOS_API_KEY=（console発行）
PORT=3000
VISION_BACKEND=direct
ANTHROPIC_API_KEY=（あなたのキー）
TRANSCRIBE_LANGUAGE=ja-JP
```

## 3. 起動 + トンネル
```
npm install
npm run dev          # = tsx watch src/server.ts
ngrok http 3000      # 別ターミナル。URL を console の Public URL に
```

## 4. Simulated Glasses 接続
- スマホの MentraOS アプリで、物理グラスの代わりに **Simulated Glasses** を選択
- このアプリを **start**
- ⚠️ Simulated の正確な UI ラベル/手順は端末で確認（research フラグ）

## 5. 検証チェックリスト（耳で確認）
| # | やること | 合格条件 | 何が分かるか |
|---|---|---|---|
| 5-1 | アプリ start 直後 | 起動挨拶 TTS が**スマホスピーカーから鳴る** | ★最大の未確認点＝Simulated で TTS 再生されるか |
| 5-2 | 「ヘルプ」と発話 | 使い方 TTS が返る | マイク→文字起こし→コマンド認識 (CRITICAL) |
| 5-3 | 「診断」と発話 | 「1、2、3」＋能力サマリ（カメラ/マイク/スピーカー/ボタン）を読み上げ | デバイス能力の取得 |
| 5-4 | 「SAA」「セキュリティ」等 | 「◯◯ を選びました」 | 試験選択（音声メニュー） |
| 5-5 | 「高精度」「節約」 | モード切替 TTS | モード切替 |
| 5-6 | 「コスト」 | セッションコスト読み上げ | usage 集計 |

> Simulated にカメラが無い場合、撮影〜解答は **`npm run sim`** に試験画面スクショ JPEG を
> 食わせて別途確認（`photo <path>` → `p` → 「答えは、◯」）。これは実機・スマホ不要。

## 6. 判定
- 5-1〜5-2 が通れば **音声 I/O は成立** → 実機購入の最大リスクはほぼ解消。
- 5-1 が Simulated で鳴らない場合 → 「Simulated では TTS 非対応」の可能性。実機購入前に
  docs.mentraglass.com で「Simulated で speaker 出力可否」を確認、または実機テストに賭ける判断材料にする。

## 7. （任意）Ring の下ごしらえ
- `.env` に `RING_TRIGGER_TOKEN=<秘密>` を追加 → `POST /ext/trigger` が開く。
- まず PC から疎通（セッションが立っている状態で）:
  ```
  curl -X POST "https://<ngrok>/ext/trigger?user=<userId>&action=capture" -H "x-trigger-token: <token>"
  ```
- 動いたら Rokid Ring を Pixel にペアし、押下キーを実測 → Tasker/MacroDroid で上の URL に割り当て。
