import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import {
  readVoiceAudio,
  readVoiceJson,
  requireOk,
  speechUploadName,
  voiceDeadline,
  voiceHttpError,
  voiceUnreachable,
} from "./voice-http.js";

/** Operator-configured endpoint only; callers cannot redirect credentials or requests. */
export class LocalVoiceProvider implements VoiceProvider {
  private readonly api: string;

  constructor() {
    const configured = process.env.VOICE_API_URL;
    if (!configured) throw new Error("Local voice is not configured on this server.");
    const url = new URL(configured);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("VOICE_API_URL must be an HTTP(S) endpoint without credentials or query.");
    }
    this.api = url.href.replace(/\/$/, "");
  }

  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "local",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      const res = await fetch(`${this.api}/voices`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: voiceDeadline(context.signal, 20_000),
        redirect: "error",
      });
      return res.ok
        ? { ok: true }
        : {
            ok: false,
            message: voiceHttpError(
              res.status,
              "Local voice",
              "checking that key",
              await readVoiceJson(res),
            ),
          };
    } catch {
      return { ok: false, message: voiceUnreachable("Local voice") };
    }
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const res = await fetch(`${this.api}/voices`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: voiceDeadline(context.signal, 20_000),
      redirect: "error",
    });
    await requireOk(res, "Local voice", "listing voices");
    const body = await readVoiceJson(res, { requireValid: true });
    if (
      !Array.isArray(body) ||
      body.some((item) => !item || typeof item.id !== "string" || typeof item.label !== "string")
    ) {
      throw new Error("Local voice returned an invalid catalog.");
    }
    return body.map(({ id, label }) => ({ id, label }));
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${this.api}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ input: request.text, voice: request.voiceId, response_format: "wav" }),
      signal,
      redirect: "error",
    });
    await requireOk(res, "Local voice", "speaking");
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/wav" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    const res = await fetch(`${this.api}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.apiKey}` },
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
      redirect: "error",
    });
    await requireOk(res, "Local voice", "transcribing");
    const body = await readVoiceJson(res, { requireValid: true });
    if (
      !body ||
      typeof body !== "object" ||
      typeof (body as { text?: unknown }).text !== "string"
    ) {
      throw new Error("Local voice returned invalid transcription.");
    }
    return { text: (body as { text: string }).text.trim() };
  }
}
