// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallBar } from "./CallCard";
import { VoiceControls } from "./VoiceControls";

const fake = vi.hoisted(() => ({
  call: null as null | { botId: string },
  end: vi.fn(),
  recorder: {
    state: { status: "idle", transcript: "" },
    subscribe: vi.fn(() => () => {}),
    stop: vi.fn(),
    listen: vi.fn(),
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/call-session", () => ({
  useCallSession: () => fake.call,
  endCall: fake.end,
  toggleMute: vi.fn(),
  toggleTranscript: vi.fn(),
}));
vi.mock("../../lib/dictation", () => ({
  Dictation: class {
    state = fake.recorder.state;
    subscribe = fake.recorder.subscribe;
    stop = fake.recorder.stop;
    listen = fake.recorder.listen;
  },
}));
const container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("matchMedia", () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}));
function button(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
afterEach(() => {
  act(() => root.unmount());
  root = createRoot(container);
  fake.call = null;
  vi.clearAllMocks();
});
describe("voice controls", () => {
  it("separates dictation from a call and delivers recognition to the current draft callback", () => {
    const onVoice = vi.fn();
    const oldDraft = vi.fn();
    const currentDraft = vi.fn();
    act(() =>
      root.render(<VoiceControls disabled={false} onVoice={onVoice} onTranscript={oldDraft} />),
    );
    act(() => button("Dictate").click());
    expect(fake.recorder.listen).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "endpoint", transcribe: true }),
    );
    expect(onVoice).not.toHaveBeenCalled();
    act(() =>
      root.render(<VoiceControls disabled={false} onVoice={onVoice} onTranscript={currentDraft} />),
    );
    act(() => fake.recorder.listen.mock.calls[0]![0].onFinal("hello"));
    expect(currentDraft).toHaveBeenCalledWith("hello");
    expect(oldDraft).not.toHaveBeenCalled();
    act(() => button("Voice").click());
    expect(fake.recorder.stop).toHaveBeenCalled();
    expect(onVoice).toHaveBeenCalledOnce();
  });
  it("prevents dictation during an active call and lets the voice button end it", () => {
    fake.call = { botId: "bot" };
    act(() =>
      root.render(<VoiceControls disabled={false} onVoice={vi.fn()} onTranscript={vi.fn()} />),
    );
    expect(button("Dictate").disabled).toBe(true);
    expect(button("Voice").getAttribute("aria-pressed")).toBe("true");
    act(() => button("Voice").click());
    expect(fake.end).toHaveBeenCalledOnce();
  });
  it("renders the compact call bar with working controls and optional transcript", () => {
    const onSettings = vi.fn(),
      onMute = vi.fn(),
      onTranscript = vi.fn(),
      onEnd = vi.fn();
    const call = {
      botId: "test-bot",
      botName: "Assistant",
      botColor: "",
      startedAt: 0,
      phase: "listening" as const,
      muted: false,
      transcriptOpen: false,
      caption: "",
      heard: "",
      exchanges: [{ role: "user" as const, text: "test phrase" }],
    };
    const render = (open: boolean) =>
      act(() =>
        root.render(
          <CallBar
            call={{ ...call, transcriptOpen: open }}
            onBotClick={vi.fn()}
            {...{ onSettings, onMute, onTranscript, onEnd }}
          />,
        ),
      );
    render(false);
    expect(container.querySelector('[data-testid="call-view"]')?.getAttribute("data-phase")).toBe(
      "listening",
    );
    expect(container.querySelector('[role="log"]')).toBeNull();
    act(() => {
      button("Settings").click();
      button("Mute").click();
      button("Transcript").click();
    });
    expect(onSettings).toHaveBeenCalledOnce();
    expect(onMute).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledOnce();
    render(true);
    expect(container.querySelector('[role="log"]')?.textContent).toContain("test phrase");
    act(() => button("Hang up").click());
    expect(onEnd).toHaveBeenCalledOnce();
  });
});
