/**
 * Simulated CLI — グラス無しで AWS Quiz のフローを手元で回す。
 *
 *   npm run sim
 *
 * @mentra/sdk も Mentra の API キーも不要。VISION_BACKEND_URL の実 FastAPI バックエンドを
 * 実 JPEG で叩けるので、撮影〜推論〜読み上げ整形まで一気通貫で検証できる。
 *
 * コマンド (stdin):
 *   photo <path>   撮影対象の JPEG/PNG を設定
 *   p | press      短押し = 撮影トリガ (= ボタン短押し)
 *   L | long       長押し = モード切替
 *   <その他の文章>  音声コマンドとして解釈 (例: "SAA" / "コスト" / "もう一度" / "ヘルプ")
 *   help           使い方
 *   quit | exit    終了
 */

import { createInterface } from "node:readline";
import { QuizController } from "../core/quizController.js";
import { QuizSession } from "../core/quizSession.js";
import type { AuthMode, InferenceMode } from "../vision/visionBackend.js";
import { HttpVisionBackend } from "../vision/httpVisionBackend.js";
import { FakeCamera, FakeTrigger, FakeVoiceIO } from "./fakeIO.js";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

const backendUrl = env("VISION_BACKEND_URL", "http://localhost:8080");
const backend = new HttpVisionBackend({ baseUrl: backendUrl });

let photoPath: string | null = null;

const voice = new FakeVoiceIO();
const camera = new FakeCamera(() => photoPath);
const trigger = new FakeTrigger();

const session = new QuizSession({
  camera,
  voice,
  backend,
  config: {
    examCode: env("DEFAULT_EXAM_CODE", "SAA"),
    mode: env("DEFAULT_INFERENCE_MODE", "opus") as InferenceMode,
    authMode: env("DEFAULT_AUTH_MODE", "api_key") as AuthMode,
    autoLoopDelayMs: 0,
  },
});

const controller = new QuizController({ session, voice, trigger, backend });
controller.start();

function banner(): void {
  process.stdout.write(
    [
      "",
      "── AWS Quiz Glass — Simulated CLI ─────────────────────────",
      `  backend : ${backendUrl}`,
      `  exam    : ${session.getConfig().examCode}  mode: ${session.getConfig().mode}/${session.getConfig().authMode}`,
      "  commands:",
      "    photo <path>   set the JPEG/PNG to 'capture'",
      "    p | press      short press (capture & solve)",
      "    L | long       long press (toggle accuracy/economy)",
      "    <text>         spoken command (e.g. SAA, コスト, もう一度, ヘルプ)",
      "    help | quit",
      "───────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
}

void controller.welcome().then(banner);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
rl.prompt();

rl.on("line", (line) => {
  const s = line.trim();
  if (s === "") {
    rl.prompt();
    return;
  }
  if (s === "quit" || s === "exit") {
    rl.close();
    return;
  }
  if (s === "help") {
    banner();
    rl.prompt();
    return;
  }
  if (s === "p" || s === "press") {
    trigger.pressShort();
  } else if (s === "L" || s === "long") {
    trigger.pressLong();
  } else if (s.startsWith("photo ")) {
    photoPath = s.slice("photo ".length).trim();
    process.stdout.write(`📷  photo set: ${photoPath}\n`);
  } else if (s === "nophoto") {
    photoPath = null;
    process.stdout.write("📷  photo cleared\n");
  } else {
    // 音声コマンドとして注入
    voice.emit(s);
  }
  // 非同期フロー (撮影→推論→読み上げ) の出力が混ざるので少し待ってから prompt
  setTimeout(() => rl.prompt(), 50);
});

rl.on("close", () => {
  controller.dispose();
  process.stdout.write("bye\n");
  process.exit(0);
});
