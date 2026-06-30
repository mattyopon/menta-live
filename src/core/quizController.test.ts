import assert from "node:assert/strict";
import { test } from "node:test";
import type { Camera, CapturedPhoto, Trigger, VoiceIO } from "../io/ports.js";
import type { UsageSession, VisionBackend, VisionResult } from "../vision/visionBackend.js";
import { QuizController } from "./quizController.js";
import { QuizSession } from "./quizSession.js";

const PHOTO: CapturedPhoto = { bytes: new Uint8Array([1]), mimeType: "image/jpeg" };
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

class NoopVoice implements VoiceIO {
  speak(): Promise<void> {
    return Promise.resolve();
  }
  stop(): void {}
  onUtterance(): () => void {
    return () => {};
  }
}
class NoopTrigger implements Trigger {
  onShortPress(): () => void {
    return () => {};
  }
  onLongPress(): () => void {
    return () => {};
  }
}
class StubBackend implements VisionBackend {
  infer(): Promise<VisionResult> {
    return Promise.resolve({ requestId: "x", text: "A", elapsedMs: 1, model: "m" });
  }
  getUsageSession(): Promise<UsageSession> {
    return Promise.resolve({ total_usd: 0, breakdown: {} });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function makeSession(camera: Camera, mode: "haiku" | "opus" = "haiku") {
  return new QuizSession({
    camera,
    voice: new NoopVoice(),
    backend: new StubBackend(),
    config: { examCode: "SAA", mode, authMode: "api_key", autoLoopDelayMs: 0, slowCueAfterMs: 0 },
    genRequestId: () => "rid",
  });
}

test("external('capture') drives the same capture flow as a ring/button press", async () => {
  let captures = 0;
  const camera: Camera = {
    capturePhoto: () => {
      captures += 1;
      return Promise.resolve(PHOTO);
    },
  };
  const session = makeSession(camera);
  const controller = new QuizController({
    session,
    voice: new NoopVoice(),
    trigger: new NoopTrigger(),
    backend: new StubBackend(),
  });
  await controller.external("capture");
  await flush();
  assert.equal(captures, 1);
});

test("external('toggleMode') flips the accuracy/economy profile", async () => {
  const session = makeSession({ capturePhoto: () => Promise.resolve(PHOTO) }, "opus");
  const controller = new QuizController({
    session,
    voice: new NoopVoice(),
    trigger: new NoopTrigger(),
    backend: new StubBackend(),
  });
  assert.equal(session.getConfig().authMode, "api_key");
  await controller.external("toggleMode");
  assert.equal(session.getConfig().authMode, "max_sub");
  assert.equal(session.getConfig().mode, "haiku");
});
