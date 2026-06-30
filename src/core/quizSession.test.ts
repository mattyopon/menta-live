import assert from "node:assert/strict";
import { test } from "node:test";
import type { Camera, CapturedPhoto, VoiceIO } from "../io/ports.js";
import {
  BackendError,
  type UsageSession,
  type VisionBackend,
  type VisionRequest,
  type VisionResult,
} from "../vision/visionBackend.js";
import { QuizSession } from "./quizSession.js";

const PHOTO: CapturedPhoto = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" };
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

class RecordingVoice implements VoiceIO {
  spoken: string[] = [];
  stops = 0;
  speak(t: string): Promise<void> {
    this.spoken.push(t);
    return Promise.resolve();
  }
  stop(): void {
    this.stops++;
  }
  onUtterance(): () => void {
    return () => {};
  }
}

class StubCamera implements Camera {
  calls = 0;
  constructor(private fn: () => Promise<CapturedPhoto>) {}
  capturePhoto(): Promise<CapturedPhoto> {
    this.calls++;
    return this.fn();
  }
}

class StubBackend implements VisionBackend {
  calls = 0;
  constructor(private fn: (req: VisionRequest, n: number) => Promise<VisionResult>) {}
  infer(req: VisionRequest): Promise<VisionResult> {
    this.calls++;
    return this.fn(req, this.calls);
  }
  getUsageSession(): Promise<UsageSession> {
    return Promise.resolve({ total_usd: 0, breakdown: {} });
  }
  health(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function mk(camera: Camera, backend: VisionBackend, voice = new RecordingVoice()) {
  let n = 0;
  const session = new QuizSession({
    camera,
    voice,
    backend,
    config: { examCode: "SAA", mode: "haiku", authMode: "api_key", autoLoopDelayMs: 0 },
    genRequestId: () => `rid-${n++}`,
  });
  return { session, voice };
}

test("happy path: capture → infer → speak answer", async () => {
  const camera = new StubCamera(() => Promise.resolve(PHOTO));
  const backend = new StubBackend(() => Promise.resolve({ requestId: "x", text: "A", elapsedMs: 1, model: "m" }));
  const { session, voice } = mk(camera, backend);
  session.onTrigger();
  await flush();
  assert.equal(session.getPhase(), "idle");
  assert.deepEqual(voice.spoken, ["答えは、A"]);
  assert.equal(backend.calls, 1);
});

test("camera failure speaks a camera error and does not call backend", async () => {
  const camera = new StubCamera(() => Promise.reject(new Error("no cam")));
  const backend = new StubBackend(() => Promise.resolve({ requestId: "x", text: "A", elapsedMs: 1, model: "m" }));
  const { session, voice } = mk(camera, backend);
  session.onTrigger();
  await flush();
  assert.equal(backend.calls, 0);
  assert.match(voice.spoken[0] ?? "", /カメラの取得に失敗/);
});

test("read_timeout retries once with the same request id, then succeeds", async () => {
  const camera = new StubCamera(() => Promise.resolve(PHOTO));
  const seenIds: string[] = [];
  const backend = new StubBackend((req, n) => {
    seenIds.push(req.requestId);
    if (n === 1) return Promise.reject(new BackendError("read_timeout", "t"));
    return Promise.resolve({ requestId: req.requestId, text: "B", elapsedMs: 1, model: "m" });
  });
  const { session, voice } = mk(camera, backend);
  session.onTrigger();
  await flush();
  assert.equal(backend.calls, 2);
  assert.equal(seenIds[0], seenIds[1], "retry must reuse the same request_id (backend dedup)");
  assert.deepEqual(voice.spoken, ["答えは、B"]);
});

test("non-retryable http error speaks once, no retry", async () => {
  const camera = new StubCamera(() => Promise.resolve(PHOTO));
  const backend = new StubBackend(() => Promise.reject(new BackendError("http", "rate", 429)));
  const { session, voice } = mk(camera, backend);
  session.onTrigger();
  await flush();
  assert.equal(backend.calls, 1);
  assert.match(voice.spoken[0] ?? "", /混み合って/);
});

test("re-trigger while capturing is ignored", async () => {
  let resolveCam: (p: CapturedPhoto) => void = () => {};
  const camera = new StubCamera(() => new Promise<CapturedPhoto>((r) => (resolveCam = r)));
  const backend = new StubBackend(() => Promise.resolve({ requestId: "x", text: "A", elapsedMs: 1, model: "m" }));
  const { session } = mk(camera, backend);
  session.onTrigger(); // phase: capturing (camera pending)
  await flush(2);
  assert.equal(session.getPhase(), "capturing");
  session.onTrigger(); // should be ignored
  session.onTrigger();
  assert.equal(camera.calls, 1, "concurrent triggers must not start a second capture");
  resolveCam(PHOTO);
  await flush();
  assert.equal(backend.calls, 1);
});
