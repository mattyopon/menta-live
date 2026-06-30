# mentra-aws-quiz

**AWS 認定試験の解答アシスタント — Mentra Live (表示なしスマートグラス) 版。**

[`mattyopon/rokid-glass-day1`](https://github.com/mattyopon/rokid-glass-day1) の「カメラで試験画面を撮影 → Anthropic Vision → 解答記号を **HUD 表示**」を、**MentraOS / Mentra Live** に移植したもの。Mentra Live はディスプレイが無いため、HUD 表示を **TTS 読み上げ** に、メニュー/テンプルタップを **音声コマンド + 物理ボタン** に置き換えている。

> ⚠️ これは試験対策の自己学習補助を意図した個人実験です。試験規約・各種ポリシーの遵守は利用者の責任です。

---

## 1. 何を移植したか / 何を再利用したか

元 (Rokid) は **3 層**: `Android+HUD クライアント` → `FastAPI バックエンド (頭脳)` → `Anthropic Vision`。

移植は **クライアント層だけを差し替える**。推論の頭脳（Anthropic 呼び出し / `request_id` dedup / `auth_mode` / AWS-knowledge MCP grounding / rate-limit fallback）は **既存の `backend/` (FastAPI) をそのまま再利用** する（`VISION_BACKEND=http`、既定）。

FastAPI を立てたくない場合は **`VISION_BACKEND=direct`**：`DirectAnthropicVisionBackend` が `@anthropic-ai/sdk` で Anthropic Vision を直叩きし、`inference.py` 相当（base64 画像、MCP コネクタ `mcp-client-2025-11-20`、opus→haiku の rate-limit fallback、60 秒 dedup、usage 集計）をこの Node プロセス内で完結させる（`ANTHROPIC_API_KEY` が必要。max_sub OAuth は direct では非対応）。

| 観点 | Rokid 版 (ディスプレイ有) | Mentra Live 版 (表示なし) | 実装 |
|---|---|---|---|
| 問題提示 | 画面 + 音声 | — (撮影するだけ) | — |
| トリガ | テンプルタップ (`KEYCODE_ENTER`) | **物理ボタン短押し** / 音声「撮影」 | `MentraTrigger` |
| 撮影 | CameraX 1568×1176 JPEG | `session.camera.requestPhoto` 1080p | `MentraCamera` |
| 推論 | FastAPI `/vision/session` | **同じ** FastAPI、または Anthropic 直叩き | `HttpVisionBackend` / `DirectAnthropicVisionBackend` |
| 解答提示 | HUD に記号表示 (5s) | **TTS で読み上げ** ("答えは、A") | `MentraVoiceIO` |
| 試験選択 | `MenuActivity` 視覚メニュー | **音声** ("SAA" / "セキュリティ") | `QuizController` + `examMatcher` |
| モード切替 | メニュー行 | **ボタン長押し** / 音声「高精度/節約」 | `QuizController` |
| コスト確認 | `CostActivity` 画面 | 音声「コスト」→ TTS | `QuizController` |
| 状態機械 | `AppViewModel` (Idle/Capturing/Uploading/Showing/Error) | **同型** (speaking/speakingError に改名) | `QuizSession` |

13 試験 (CLF/AIF/SAA/MLA/SOA/DEA/DVA/SAP/AIP/DOP/MLS/SCS/ANS) の system prompt は `ExamPrompts.kt` を **verbatim 移植** (`src/exams/examPrompts.ts`)。プロンプトは「画面撮影 → 記号だけ返す」用に調整済みで、撮影フローが同一の Mentra Live でもそのまま有効。

---

## 2. アーキテクチャ — 音声 I/O だけでどう成立させるか

**核心: 視覚 UI を全廃し、すべてを TTS 出力 + 文字起こし入力 + ボタン 1 個に再構成する。**

`QuizSession` (状態機械) と `QuizController` (コマンド配線) は **`@mentra/sdk` に依存しない**。ハード I/O は 3 つのポート (`VoiceIO` / `Camera` / `Trigger`) に抽象化し、Mentra アダプタを差し込む。これで (a) コアを SDK 無しでテストでき、(b) `src/sim` の偽 I/O で実機なし検証でき、(c) 他機種にも write-once で載る。

```
@mentra/sdk AppServer.onSession(session)
   │
   ├─ MentraVoiceIO   implements VoiceIO   ── session.audio.speak / session.events.onTranscription
   ├─ MentraCamera    implements Camera    ── session.camera.requestPhoto
   ├─ MentraTrigger   implements Trigger   ── session.events.onButtonPress
   │
   ├─ QuizController  ── 音声コマンド/ボタン → QuizSession  (examMatcher で発話を解釈)
   └─ QuizSession     ── 撮影→推論→読み上げ の状態機械 (= AppViewModel 移植)
          │
          └─ HttpVisionBackend implements VisionBackend
                 │  multipart POST
                 ▼
          既存 FastAPI  /vision/session   →   Anthropic Vision (haiku/sonnet/opus)
```

**正常フロー**: ボタン短押し → `onTrigger` → `capturePhoto` → `POST /vision/session` (試験別 prompt) → 返ってきた記号 `"A"` / `"A, C"` → `answerToSpeech` → `session.audio.speak("答えは、A")`。
`request_id` による stale guard・connect/read timeout の単発リトライ (同 id 再送 = backend dedup と整合)・成功時のみの AUTO_LOOP は設計書通り維持 (`src/core/quizSession.ts`)。

**音声レイテンシ補償**: 表示なし機では押下〜解答の数秒が無音になり押せたか分からない。Rokid 版 HUD の「⏳思考中 N.Ns」ティッカーの代わりに、(1) 押下直後に即時キュー「はい」(非ブロッキング=撮影と並行)、(2) `SLOW_CUE_AFTER_MS` 超でまだ待つとき一度だけ安心キュー「確認中です」を流す。`.env` の `CAPTURE_CUE_TEXT` / `SLOW_CUE_TEXT` で文言変更・`off` で無効化。

**重要**: マイクは周囲の発話を全部拾う。`recognizeCommand` が認識した明示コマンドとボタン以外には**一切反応しない**（勝手に喋らない）。

---

## 3. SDK バージョンの注意 ⚠️

- 本実装は **`@mentra/sdk@2.1.29`** (npm `latest`) に対して型・シグネチャを検証済み。`AppServer` を継承し `onSession(session, sessionId, userId)` を override、出力は `session.audio.speak`、入力は `session.events.onTranscription`。
- **v3 (alpha, `3.0.0-alpha.x`) は別 API**（`MiniAppServer` / `session.speaker.speak` / `session.transcription.on`）。docs.mentraglass.com の quickstart は v3 形を載せていることがある。**インストールしたバージョンに必ず合わせること。** 本リポは `package.json` で `^2.1.29` に固定。

---

## 4. セットアップ

### 4.1 前提
- **Node.js 20+**（このアプリは `npm`/`tsx` で動く。MentraOS 公式 example は Bun 推奨だが本リポは Node でも動作）。
- **ngrok**（ローカルを公開するため）。
- 動かす推論バックエンド: `rokid-glass-day1/backend`（FastAPI）。`ANTHROPIC_API_KEY` が必要。

### 4.2 推論バックエンド (頭脳) を起動 — 再利用
`rokid-glass-day1` をクローンし、その README 通りに backend を起動するだけ:
```bash
cd rokid-glass-day1/backend
cp .env.example .env        # ANTHROPIC_API_KEY を記入 (default は AUTH_MODE=api_key, ToS クリーン)
uv run uvicorn main:app --host 0.0.0.0 --port 8080
```
`GET http://localhost:8080/health` が `{"status":"ok"}` を返せば OK。

### 4.3 このアプリの設定
```bash
cp .env.example .env
# PACKAGE_NAME, MENTRAOS_API_KEY は console.mentraglass.com で発行 (4.4)
# VISION_BACKEND_URL=http://localhost:8080  (上の backend を指す)
npm install
```

### 4.4 Developer Console でアプリ登録 (`console.mentraglass.com`)
MentraOS スマホアプリと**同じアカウント**でログイン → **Create App**:
1. **Package name** を `.env` の `PACKAGE_NAME` と**完全一致**で設定（reverse-DNS, 例 `com.mattyopon.awsquiz`）。
2. **Public URL** (= App Server URL) に **ngrok の URL**（末尾スラッシュ無し）。
3. **Permissions** に **MICROPHONE**（必須: これが無いと文字起こしが流れない）。撮影を使うので **CAMERA** も追加。
4. **API key** を発行 → `.env` の `MENTRAOS_API_KEY` に貼る。

### 4.5 起動 + トンネル
```bash
# ターミナル 1: アプリ
npm run dev            # = tsx watch src/server.ts (本番ビルドは npm run build && npm start)

# ターミナル 2: 公開トンネル (PORT と一致させる)
ngrok http 3000
# 初回のみ: ngrok config add-authtoken <token>
```
ngrok の URL が変わったら Console の Public URL を更新する（無料枠は ~2h で失効）。

### 4.6 Simulated Glasses で実機なし検証
- 「Simulated Glasses」は **MentraOS スマホアプリ内のモード**（独立した Web シミュレータや CLI フラグではない）。
- スマホアプリで物理グラスの代わりに Simulated Glasses を選び、自分のアプリを起動する。**スマホのマイク**が文字起こし入力になる。
- ⚠️ **要確認**: Simulated モードで **TTS がスマホのスピーカーから鳴るか** は未確認。文字起こし入力は確認済みだが、TTS 再生は実機/実端末で要検証。

---

## 5. 実行モードまとめ

| コマンド | 内容 | 必要なもの |
|---|---|---|
| `npm run sim` | **グラス不要**。CLI でフローを駆動。実 JPEG を実 backend に投げて読み上げ整形まで検証 | backend |
| `npm run hello` | 最小アプリ「音声 → 文字起こし → オウム返し」。音声 I/O 疎通用 | Mentra console + ngrok |
| `npm run dev` | 本命の AWS Quiz アプリ | Mentra console + ngrok + backend |
| `npm test` | SDK 非依存コアのユニット/結合テスト | — |

### Simulated CLI の使い方
```bash
VISION_BACKEND_URL=http://localhost:8080 npm run sim
# > SAA                      ← 試験選択 (音声コマンド模擬)
# > photo ./question.jpg     ← 試験画面のスクショを撮影対象に
# > p                        ← 短押し = 撮影→推論→「答えは、A」
# > コスト / もう一度 / ヘルプ / 高精度 / 節約
# > quit
```

---

## 6. 音声コマンド一覧（`examMatcher`）

| 言うと | 動作 |
|---|---|
| 試験コード/名称 (例「SAA」「セキュリティ」「ネットワーク」「データエンジニア」) | その試験に切替 |
| 「撮影」「撮って」「解いて」 | 撮影トリガ（ボタン短押しと同等） |
| 「もう一度」「リピート」 | 直前の解答を再読み上げ |
| 「コスト」「料金」「いくら」 | セッションの API コストを読み上げ |
| 「高精度」/「節約」 | api_key+opus / max_sub+haiku に切替（ボタン長押しでトグルも可） |
| 「一覧」「リスト」 | 対応試験を読み上げ |
| 「診断」「セルフテスト」 | TTS セルフテスト＋デバイス能力（カメラ/マイク/スピーカー/ボタン）読み上げ（実機確認用） |
| 「ヘルプ」「使い方」 | 操作説明 |

解答の読み上げは、単一は「答えは、A」、複数選択は数を先に言って「答えは2つ。AとC」。rate-limit で
opus→haiku に格下げされた場合は「答えは、A。ハイクで回答」と注記（`ANNOUNCE_FALLBACK`）。

> ASR の認識精度に依存するため、`src/exams/examMatcher.ts` の alias 追加が主なチューニングポイント。別言語 ASR への載せ替えもここを足すだけ。

---

## 7. プロジェクト構成

```
src/
  server.ts                 本命アプリ: AppServer.onSession で全部を配線
  hello/helloServer.ts      Hello World (音声→文字起こし→オウム返し)
  config.ts                 .env ローダ (API キー名の揺れを吸収)
  io/ports.ts               VoiceIO / Camera / Trigger / Logger ポート (SDK 非依存)
  exams/
    examPrompts.ts          ★ ExamPrompts.kt の verbatim 移植 (13 試験)
    examMatcher.ts          音声コマンド → Command 解釈
  vision/
    visionBackend.ts        VisionBackend ポート + 型 + BackendError
    httpVisionBackend.ts    ★ BackendClient.kt の移植 (multipart + エラー写像)
  core/
    quizSession.ts          ★ AppViewModel.kt の移植 (状態機械)
    quizController.ts        音声/ボタン → QuizSession
    speech.ts               解答/エラー/コスト → 読み上げ日本語
  mentra/
    mentraVoiceIO.ts        VoiceIO の @mentra/sdk 実装 (audio.speak / events.onTranscription)
    mentraCamera.ts         Camera の実装 (camera.requestPhoto)
    mentraTrigger.ts        Trigger の実装 (events.onButtonPress)
  sim/
    fakeIO.ts, simCli.ts    グラス無し検証ハーネス
  **/*.test.ts              ユニット/結合テスト (node:test)
```

---

## 8. 手動で要確認のチェックリスト ⚠️

「推測でAPIを書かない」方針で、一次ソースで確証できなかった点を明示する。実機/`docs.mentraglass.com` で確認のこと。

- [ ] **インストールした `@mentra/sdk` が v2 系**であること（v3 は API 別物）。本リポは 2.1.29 前提。
- [ ] **Simulated モードで TTS がスマホスピーカーから鳴るか**（文字起こし入力は確認済、TTS 再生は未確認）。
- [ ] **日本語 TTS の声質**: `SpeakOptions` に `language` は無く、ElevenLabs (`eleven_flash_v2_5`) がテキストから言語推定する。日本語が不自然なら `.env` の `TTS_VOICE_ID` に多言語/日本語 voice を指定（voice id は console / ElevenLabs 側で確認）。
- [ ] **`onTranscriptionForLanguage("ja-JP", …)` が mic を自動 enable するか**（subscribe 自体は発火するはず。流れてこなければ MICROPHONE 権限と合わせて確認）。
- [ ] **Console の API キー env 名**: 本リポは `MENTRAOS_API_KEY` / `MENTRA_API_KEY` / `API_KEY` の順で読む。クローンしたテンプレートと揃っているか。
- [ ] **Mentra Live のボタン profile**（公式 capabilities では 1 ボタン・スワイプ無し）。ファームウェアにより差異がないか。
- [ ] **AppServer のインスタンス化**: 本リポは `new AwsQuizServer({ packageName, apiKey, port })` で明示注入。公式 example は無引数 + 内部 env 読み。どちらでも動くが流儀の違いに注意。

---

## 9. ライセンス / 注意
個人実験。`backend` の `AUTH_MODE=max_sub` (Max sub OAuth 流用) は Anthropic ToS リスクあり（`rokid-glass-day1` README 参照）。default の `api_key` を推奨。
