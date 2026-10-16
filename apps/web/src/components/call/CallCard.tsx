import { useLingui } from "@lingui/react/macro";
import { BotAvatar, Button, cn } from "@rakazo/ui-web";
import { Captions, Mic, MicOff, Settings, X } from "lucide-react";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { CallState } from "../../lib/call-session";
import { endCall, toggleMute, toggleTranscript, useCallSession } from "../../lib/call-session";

const TRANSCRIPT_LINES = 4;
const EDITABLE = /^(?:input|textarea|select)$/i;

export function CallCard({ onSettings }: { onSettings: () => void }) {
  const call = useCallSession();
  const navigate = useNavigate();
  const { botId } = useParams();
  const onCall = Boolean(call);
  useEffect(() => {
    if (!onCall) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || EDITABLE.test(target?.tagName ?? "")) return;
      endCall();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCall]);
  if (!call) return null;
  return (
    <CallBar
      call={call}
      onSettings={onSettings}
      onBotClick={() => {
        if (botId !== call.botId) navigate(`/app/${call.botId}`);
      }}
      onMute={toggleMute}
      onTranscript={toggleTranscript}
      onEnd={endCall}
    />
  );
}

export function CallBar({
  call,
  onSettings,
  onBotClick,
  onMute,
  onTranscript,
  onEnd,
}: {
  call: CallState;
  onSettings: () => void;
  onBotClick: () => void;
  onMute: () => void;
  onTranscript: () => void;
  onEnd: () => void;
}) {
  const { t } = useLingui();
  return (
    <div
      data-testid="call-view"
      data-phase={call.phase}
      className="fixed bottom-6 start-1/2 z-50 w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2"
    >
      {call.transcriptOpen ? (
        <div
          className="mb-3 flex max-h-60 flex-col gap-2 overflow-y-auto rounded-2xl border border-border bg-card p-4 text-sm shadow-lg"
          role="log"
          aria-label={t`Transcript`}
        >
          {call.exchanges.slice(-TRANSCRIPT_LINES).map((exchange, index) => (
            <p
              key={`${exchange.role}-${index}`}
              className={cn(
                "break-words",
                exchange.role === "bot" ? "text-foreground" : "text-muted-foreground",
              )}
              dir="auto"
            >
              {exchange.text}
            </p>
          ))}
          {call.caption || call.heard ? (
            <p className="break-words text-muted-foreground" dir="auto">
              {call.caption || call.heard}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-3 rounded-full border border-border bg-card px-4 py-3 shadow-lg sm:gap-4 sm:px-5">
        <button
          type="button"
          aria-label={t`On a call with ${call.botName}`}
          title={call.botName}
          onClick={onBotClick}
          className="shrink-0 rounded-full"
        >
          <BotAvatar color={call.botColor} identity={call.botId} size={44} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
            <span
              key={index}
              className={cn(
                "h-1.5 flex-1 rounded-full bg-foreground/20",
                !call.muted &&
                  (call.phase === "thinking" ? "animate-pulse" : "animate-pulse bg-foreground"),
              )}
              style={{
                animationDelay: `${index * 100}ms`,
                animationDuration: call.phase === "speaking" ? "600ms" : "1500ms",
              }}
            />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
          <Button
            variant="secondary"
            size="icon"
            className="size-10 rounded-full sm:size-12"
            aria-label={t`Settings`}
            onClick={onSettings}
          >
            <Settings className="size-5" />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            className="size-10 rounded-full sm:size-12"
            aria-label={t`Transcript`}
            aria-pressed={call.transcriptOpen}
            onClick={onTranscript}
          >
            <Captions className="size-5" />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            className="size-10 rounded-full sm:size-12"
            aria-label={call.muted ? t`Unmute` : t`Mute`}
            aria-pressed={call.muted}
            onClick={onMute}
          >
            {call.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </Button>
          <Button
            variant="destructive"
            size="icon"
            className="size-12 rounded-full sm:size-14"
            aria-label={t`Hang up`}
            onClick={onEnd}
          >
            <X className="size-6" />
          </Button>
        </div>
      </div>
    </div>
  );
}
