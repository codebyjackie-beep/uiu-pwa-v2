/**
 * Shrink a recipe video in the browser so it fits the 14 MB upload cap (Jackie 2026-11-07: ">14 MB" item).
 *
 * How: play the video (silently, sound routed into the recording only) and re-record it at ≤640px wide and a low
 * bitrate with MediaRecorder — canvas.captureStream() for the picture, Web Audio for the sound (Safari has no
 * HTMLMediaElement.captureStream). Takes about as long as the video itself. Only ever used when the original is over
 * the cap, so videos that already fit are untouched.
 *
 * Returns null when the browser can't do it (no MediaRecorder / captureStream / AudioContext) or anything fails —
 * the caller then shows the old "trim it" message. Not verified on real phones yet (2026-11-08).
 */

const MAX_WIDTH = 640;
const VIDEO_BITS_PER_SECOND = 900_000;
const AUDIO_BITS_PER_SECOND = 64_000;
const FPS = 24;
/** Gemini needs to see the cooking; anything longer than this would still not fit at the bitrate above. */
const MAX_DURATION_S = 150;

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  // H.264 first (most widely decoded); Safari records mp4 natively, Chrome may only offer H.264 + Opus in mp4.
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a",
    "video/mp4;codecs=avc1.42E01E,opus",
    "video/mp4",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export function canShrinkVideo(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const canvas = document.createElement("canvas") as HTMLCanvasElement & { captureStream?: unknown };
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return !!pickMimeType() && typeof canvas.captureStream === "function" && !!AudioCtx;
}

export async function shrinkVideo(file: File, onProgress?: (fraction: number) => void): Promise<File | null> {
  const mimeType = pickMimeType();
  if (!mimeType || !canShrinkVideo()) return null;

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";

  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();
  let recorder: MediaRecorder | null = null;
  let raf = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("video could not be read"));
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > MAX_DURATION_S) return null;

    const scale = Math.min(1, MAX_WIDTH / (video.videoWidth || MAX_WIDTH));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round((video.videoWidth || MAX_WIDTH) * scale / 2) * 2);
    canvas.height = Math.max(2, Math.round((video.videoHeight || MAX_WIDTH) * scale / 2) * 2);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Sound goes into the recording only (not to the speakers).
    const source = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);
    if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});

    const canvasStream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(FPS);
    const stream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder!.onstop = () => resolve();
    });

    const draw = () => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      onProgress?.(Math.min(1, video.currentTime / video.duration));
      if (!video.ended && !video.paused) raf = requestAnimationFrame(draw);
    };

    recorder.start(1000);
    await video.play();
    draw();
    await new Promise<void>((resolve, reject) => {
      video.onended = () => resolve();
      video.onerror = () => reject(new Error("playback failed"));
    });
    recorder.stop();
    await stopped;
    onProgress?.(1);

    // The API only accepts plain "video/mp4" / "video/webm" data URLs (no codecs parameter).
    const baseType = mimeType.startsWith("video/mp4") ? "video/mp4" : "video/webm";
    const blob = new Blob(chunks, { type: baseType });
    if (blob.size === 0) return null;
    const name = file.name.replace(/\.[^.]+$/, "") + (baseType === "video/mp4" ? "-small.mp4" : "-small.webm");
    return new File([blob], name, { type: baseType });
  } catch {
    return null;
  } finally {
    cancelAnimationFrame(raf);
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    video.pause();
    URL.revokeObjectURL(url);
    audioCtx.close().catch(() => {});
  }
}
