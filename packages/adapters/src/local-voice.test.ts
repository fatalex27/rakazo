import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalVoiceProvider } from "./local-voice.js";
import { createVoiceProvider, isVoiceProviderId, listVoiceCatalog } from "./voice-factory.js";

const ctx = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("operator-hosted voice", () => {
  it("is only advertised and accepted when the operator configures an endpoint", () => {
    vi.stubEnv("VOICE_API_URL", "");
    expect(listVoiceCatalog().some((entry) => entry.id === "local")).toBe(false);
    expect(isVoiceProviderId("local")).toBe(false);
    expect(() => createVoiceProvider("local")).toThrow(/not configured/);
    vi.stubEnv("VOICE_API_URL", "http://voice:8000/v1");
    expect(isVoiceProviderId("local")).toBe(true);
    expect(listVoiceCatalog().find((entry) => entry.id === "local")?.transcribe).toBe(true);
    expect(createVoiceProvider("local").describe().capabilities.transcribe).toBe(true);
  });

  it.each([
    "file:///etc/passwd",
    "http://user:secret@voice/v1",
    "http://voice/v1?token=x",
    "http://voice/v1#x",
  ])("rejects unsafe configuration %s", (endpoint) => {
    vi.stubEnv("VOICE_API_URL", endpoint);
    expect(() => new LocalVoiceProvider()).toThrow();
  });

  it("checks authentication without following redirects and reports an unavailable service", async () => {
    vi.stubEnv("VOICE_API_URL", "http://voice:8000/v1/");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockRejectedValueOnce(new Error("down"));
    vi.stubGlobal("fetch", fetcher);
    const provider = new LocalVoiceProvider();
    expect((await provider.verify("test-token", ctx)).ok).toBe(false);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://voice:8000/v1/voices");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer test-token" },
    });
    expect((await provider.verify("test-token", ctx)).ok).toBe(false);
  });

  it("reads the real catalog and synthesizes WAV through the same configured server", async () => {
    vi.stubEnv("VOICE_API_URL", "http://voice:8000/v1");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "orc-ru", label: "Orc" }])))
      .mockResolvedValueOnce(new Response(new Uint8Array([82, 73, 70, 70])));
    vi.stubGlobal("fetch", fetcher);
    const provider = new LocalVoiceProvider();
    expect(await provider.listVoices("test-token", ctx)).toEqual([{ id: "orc-ru", label: "Orc" }]);
    const clip = await provider.synthesize(
      { text: "Hello", voiceId: "orc-ru", apiKey: "test-token" },
      ctx,
    );
    expect(clip.mimeType).toBe("audio/wav");
    expect([...clip.bytes]).toEqual([82, 73, 70, 70]);
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({
      input: "Hello",
      voice: "orc-ru",
      response_format: "wav",
    });
  });

  it("uploads audio for local transcription and rejects malformed provider results", async () => {
    vi.stubEnv("VOICE_API_URL", "http://voice:8000/v1");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: " hello " })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 42 })))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 42 }])));
    vi.stubGlobal("fetch", fetcher);
    const provider = new LocalVoiceProvider();
    const request = { audio: new Uint8Array([1, 2]), mimeType: "audio/webm", apiKey: "test-token" };
    expect(await provider.transcribe(request, ctx)).toEqual({ text: "hello" });
    expect(fetcher.mock.calls[0]?.[1].body.get("file").name).toBe("speech.webm");
    await expect(provider.transcribe(request, ctx)).rejects.toThrow(/invalid transcription/);
    await expect(provider.listVoices("test-token", ctx)).rejects.toThrow(/invalid catalog/);
  });
});
