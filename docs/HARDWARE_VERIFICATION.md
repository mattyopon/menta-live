# 実機検証手順 (Mentra Live 到着後)

表示なし機なので、検証は**耳と物理操作だけ**で完結する手順に組んである。Rokid 版の
`docs/superpowers/specs/.../day1-design.md` §6 の「端末 I/O を先に潰す」方針を踏襲。

各項目は **合格条件を耳で確認** できる形にしてある。`adb logcat` 相当は MentraOS では
ローカルの `npm run dev` コンソールログで代替する（`session.logger` 出力）。

> アプリ内の音声コマンド「**診断**」を言うと、TTS セルフテスト（「1、2、3」）→ デバイス能力
> サマリ（機種/ディスプレイ/カメラ/マイク/スピーカー/ボタンの有無）を読み上げる。
> Step 1〜4 はこの「診断」一発で大半を確認できる。

---

## Step 0: Simulated モードで事前確認（実機前）
- `npm run sim` で状態機械・コマンド認識・（実 backend を繋げば）撮影〜解答整形まで確認済みであること。
- **合格**: `SAA` → `photo <jpeg>` → `p` で「答えは、◯」が出力される。

## Step 1: 接続とセッション開始
- console.mentraglass.com で Package name 一致・Public URL(ngrok)・**MICROPHONE + CAMERA** 権限を設定。
- `npm run dev` + `ngrok http 3000` を起動し、Mentra スマホアプリから本アプリを起動。
- **合格**: 起動時の挨拶 TTS（「AWSクイズアシスタントです…」）が**スピーカーから鳴る**。
  - ⚠️ Simulated モードで鳴らない場合は実機 or 実端末で要再確認（research フラグ: Simulated の TTS 再生は未確認）。

## Step 2: マイク（文字起こし）疎通  ← CRITICAL
- 「**ヘルプ**」と発話する。
- **合格**: 使い方の TTS が返る（= `onTranscription` が `data.text` を届け、`recognizeCommand` が拾えている）。
- 失敗時の切り分け:
  - 無反応 → console の MICROPHONE 権限 / `TRANSCRIBE_LANGUAGE=ja-JP` を確認。`onPermissionDenied` ログを見る。
  - 別言語で認識 → `TRANSCRIBE_LANGUAGE` を実機の ASR に合わせる。

## Step 3: 「診断」でデバイス能力を確認
- 「**診断**」と発話する。
- **合格**: 「1、2、3」セルフテスト後、`機種は Mentra Live。ディスプレイ なし、カメラ あり、マイク あり、スピーカー あり、ボタン あり。` と読み上げる。
  - `capabilities` が `null` のまま（「まだ取得できていません」）なら CONNECTION_ACK 前。数秒待って再実行。
  - 公式 profile と食い違う項目があれば README §8 に追記して切り分ける。

## Step 4: 物理ボタン（短押し＝撮影トリガ）  ← CRITICAL
- 試験画面（または任意の AWS 選択問題のスクショ）に向けてボタンを**短押し**。
- **合格**: 押下直後に即時キュー「**はい**」→ 数秒後「**答えは、◯**」。
  - 「はい」も出ない → `onButtonPress` の `pressType` を確認（`short` で発火しているか）。`session.logger` に photo captured ログが出るか。
  - 「はい」は出るが解答が来ない → backend 疎通（Step 6）/ カメラ撮影（Step 5）を疑う。

## Step 5: カメラ撮影
- Step 4 のログで `photo captured: <N> bytes, image/jpeg` が出ること。
- `npm run dev` のログに送信サイズが出る。問題文が小さい場合は `MentraCamera` の `size` を `full` に上げて再検証。
- **合格**: 撮影が成功し、JPEG が backend に渡っている（bytes > 0）。

## Step 6: backend 推論（http / direct どちらか）
- **http**: `rokid-glass-day1/backend` を起動し `GET /health` が `{"status":"ok"}`。`VISION_BACKEND_URL` がそれを指す。
- **direct**: `.env` に `VISION_BACKEND=direct` と `ANTHROPIC_API_KEY` を設定。
- **合格**: 実際の試験画面で「答えは、◯」が**妥当**に返る（記号のみ）。複数選択は「答えは2つ。AとC」。

## Step 7: モード切替・コスト・連打耐性
- ボタン**長押し** or「節約」「高精度」→ モード切替 TTS。
- 「**コスト**」→ セッションコスト読み上げ（http=backend `/usage/session`、direct=プロセス内集計）。
- 撮影中の連打 → 後続が無視され、二重解答が**起きない**こと（`onTrigger` の phase ガード）。
- rate-limit で opus→haiku に落ちた場合「答えは、◯。**ハイクで回答**」と注記される（`ANNOUNCE_FALLBACK=1`）。

## Step 8: 日本語 TTS の品質
- 解答・注記が自然に聞こえるか。違和感があれば `.env` の `TTS_VOICE_ID` に日本語/多言語 voice を指定。
  - voice id は console / ElevenLabs 側で確認（research フラグ: 既定 voice の言語は未確認）。

---

## 完了の定義（耳で確認できる項目のみ）
```
✅ Step 1: 起動挨拶 TTS が鳴る
✅ Step 2: 「ヘルプ」に TTS が返る (マイク疎通)
✅ Step 3: 「診断」で能力サマリが正しい
✅ Step 4: ボタン短押し → 「はい」→ 「答えは◯」
✅ Step 5: photo captured ログ (bytes>0)
✅ Step 6: 実問題で妥当な記号が返る
✅ Step 7: モード切替/コスト/連打耐性 OK
✅ Step 8: 日本語 TTS が自然
```
未達 Step がある状態で「動作 OK」と報告しない（Rokid 版 `feedback_no_false_ok` 準拠）。
