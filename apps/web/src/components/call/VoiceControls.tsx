import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { AudioLines, LoaderCircle, Mic, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { endCall, useCallSession } from "../../lib/call-session";
import { Dictation } from "../../lib/dictation";

export function VoiceControls({
  onVoice,
  onTranscript,
  disabled,
}: {
  onVoice: () => void;
  onTranscript: (text: string) => void;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const call = useCallSession();
  const recorder = useMemo(() => new Dictation(), []);
  const [speech, setSpeech] = useState(recorder.state);
  const transcript = useRef(onTranscript);
  transcript.current = onTranscript;
  useEffect(() => {
    const unsubscribe = recorder.subscribe(setSpeech);
    return () => {
      unsubscribe();
      recorder.stop();
    };
  }, [recorder]);
  const recording = speech.status !== "idle";
  return (
    <>
      <Button
        variant="outline"
        size="icon"
        className="size-9 shrink-0 rounded-full text-foreground/75"
        aria-label={recording ? t`Stop dictation` : t`Dictate`}
        title={recording ? t`Stop dictation` : t`Dictate`}
        aria-pressed={recording}
        disabled={disabled || Boolean(call)}
        onClick={() => {
          if (recording) {
            recorder.stop();
            return;
          }
          void recorder.listen({
            mode: "endpoint",
            transcribe: true,
            onFinal: (text) => transcript.current(text),
          });
        }}
      >
        {speech.status === "transcribing" ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : recording ? (
          <Square className="size-4" />
        ) : (
          <Mic className="size-4" />
        )}
      </Button>
      <Button
        size="icon"
        className="size-10 shrink-0 rounded-full"
        aria-label={t`Voice`}
        title={t`Voice`}
        aria-pressed={Boolean(call)}
        disabled={disabled}
        onClick={() => {
          recorder.stop();
          if (call) endCall();
          else onVoice();
        }}
      >
        <AudioLines className="size-5" />
      </Button>
      {speech.error ? (
        <span
          role="alert"
          className="absolute bottom-full end-0 mb-2 max-w-80 rounded-xl border border-border bg-card p-3 text-sm text-destructive"
        >
          {speech.error}
        </span>
      ) : null}
    </>
  );
}
