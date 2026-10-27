import type { ReactNode } from "react";
import { LiveKitRoom, VideoConference } from "@livekit/components-react";
import "@livekit/components-styles";
import type { RoomPass } from "@figbloom/shared";

/**
 * One LiveKit room, full screen: a 1:1 call or a live class. LiveKit's own
 * conference layout (tiles, screen share, chat, device pickers) does the
 * heavy lifting; around it go our title bar and, for a teacher, the class
 * controls. Loaded lazily by CallHost, so nobody downloads LiveKit until
 * they actually join something.
 */
export default function CallRoom({ pass, title, subtitle, audio, video, toolbar, notice, onLeave }: {
  pass: RoomPass;
  title: string;
  subtitle?: string;
  /** start with the mic / camera on (only if the token may publish) */
  audio: boolean;
  video: boolean;
  /** extra buttons in the title bar: the teacher's class controls */
  toolbar?: ReactNode;
  /** one line over the room: "Ringing…", "Your mic is off until the teacher lets learners speak" */
  notice?: string | null;
  onLeave: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#111]" role="dialog" aria-modal="true" aria-label={title}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5 text-white">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{title}</div>
          {subtitle && <div className="truncate text-[12px] text-white/60">{subtitle}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          <button
            type="button"
            onClick={onLeave}
            className="rounded-md border border-warn-ink bg-warn-ink px-3.5 py-2 text-[12.5px] font-semibold text-white hover:brightness-95"
          >
            Leave
          </button>
        </div>
      </header>
      {notice && <div className="bg-white/10 px-4 py-2 text-center text-[12.5px] text-white">{notice}</div>}
      <div className="min-h-0 flex-1">
        <LiveKitRoom
          serverUrl={pass.url}
          token={pass.token}
          connect
          audio={audio}
          video={video}
          onDisconnected={onLeave}
          data-lk-theme="default"
          style={{ height: "100%" }}
        >
          <VideoConference />
        </LiveKitRoom>
      </div>
    </div>
  );
}
