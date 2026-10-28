import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Modal, Platform, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AndroidAudioTypePresets, AudioSession, isTrackReference, LiveKitRoom, useConnectionState, useLocalParticipant,
  useLocalParticipantPermissions, useParticipants, useTracks, VideoTrack,
} from "@livekit/react-native";
import { ConnectionState, Track, type LocalVideoTrack } from "livekit-client";
import type { RoomPass } from "@figbloom/shared";
import { ensureCallPermissions } from "./callPermissions";

const INK = "#fff";
const MUTED = "rgba(255,255,255,0.65)";

/**
 * One LiveKit room, full screen: a 1:1 call or a live class (the website's
 * CallRoom, on a phone). `audio` and `video` say whether to start publishing the
 * mic and camera, which only works if the token may publish; a learner or a
 * parent in a live class joins without. `toolbar` is the teacher's class
 * controls, `notice` one line over the room ("Ringing…").
 */
export function CallRoom({ pass, title, subtitle, audio, video, toolbar, notice, onLeave }: {
  pass: RoomPass;
  title: string;
  subtitle?: string;
  audio: boolean;
  video: boolean;
  toolbar?: ReactNode;
  notice?: string | null;
  onLeave: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The audio session has to be running before the room connects. A video call plays
  // through the speaker and a voice call through the earpiece, as a phone call does.
  useEffect(() => {
    let alive = true;
    (async () => {
      const denied = audio || video ? await ensureCallPermissions(video) : null;
      if (denied) { if (alive) setProblem(denied); return; }
      await AudioSession.configureAudio({
        android: { preferredOutputList: [video ? "speaker" : "earpiece"], audioTypeOptions: AndroidAudioTypePresets.communication },
      });
      await AudioSession.startAudioSession();
      if (alive) setReady(true);
    })().catch(() => { if (alive) setProblem("Could not start the sound for this call. Try again."); });
    return () => { alive = false; void AudioSession.stopAudioSession(); };
  }, [audio, video]);

  return (
    <Modal visible animationType="slide" onRequestClose={onLeave}>
      <View style={{ flex: 1, backgroundColor: "#111", paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 16, paddingVertical: 10 }}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "600", color: INK }}>{title}</Text>
            {!!subtitle && <Text numberOfLines={1} style={{ fontSize: 12, color: MUTED }}>{subtitle}</Text>}
          </View>
          <TouchableOpacity accessibilityRole="button" onPress={onLeave} style={{ minHeight: 44, paddingHorizontal: 18, borderRadius: 12, backgroundColor: "#B4472B", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontWeight: "700", color: "#fff" }}>Leave</Text>
          </TouchableOpacity>
        </View>
        {!!notice && <Text style={{ backgroundColor: "rgba(255,255,255,0.12)", color: INK, fontSize: 12.5, textAlign: "center", paddingHorizontal: 16, paddingVertical: 8 }}>{notice}</Text>}
        {toolbar}
        {problem ? (
          <Text style={{ color: INK, fontSize: 14, textAlign: "center", padding: 24 }}>{problem}</Text>
        ) : !ready ? (
          <ActivityIndicator color={INK} style={{ marginTop: 48 }} />
        ) : (
          <View style={{ flex: 1 }}>
            <LiveKitRoom
              serverUrl={pass.url}
              token={pass.token}
              connect
              audio={audio}
              video={video}
              options={{ adaptiveStream: { pixelDensity: "screen" } }}
              onDisconnected={onLeave}
              onError={() => setProblem("The call lost its connection.")}
            >
              <RoomView startWithVideo={video} />
            </LiveKitRoom>
          </View>
        )}
      </View>
    </Modal>
  );
}

/** Everyone in the room as tiles, and the person's own controls under them. */
function RoomView({ startWithVideo }: { startWithVideo: boolean }) {
  const state = useConnectionState();
  const participants = useParticipants();
  const cameras = useTracks([Track.Source.Camera]);
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const canPublish = !!useLocalParticipantPermissions()?.canPublish;
  const [speaker, setSpeaker] = useState(startWithVideo);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [note, setNote] = useState<string | null>(null);

  async function run(what: () => Promise<unknown>) {
    setNote(null);
    try { await what(); } catch (err) { setNote(err instanceof Error ? err.message : "That didn't work."); }
  }

  const toggleMic = () => run(async () => {
    if (!isMicrophoneEnabled) { const denied = await ensureCallPermissions(false); if (denied) throw new Error(denied); }
    await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
  });
  const toggleCamera = () => run(async () => {
    if (!isCameraEnabled) { const denied = await ensureCallPermissions(true); if (denied) throw new Error(denied); }
    await localParticipant.setCameraEnabled(!isCameraEnabled);
  });
  const flipCamera = () => run(async () => {
    const track = localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined;
    const next = facing === "user" ? "environment" : "user";
    await track?.restartTrack({ facingMode: next });
    setFacing(next);
  });
  const toggleSpeaker = () => run(async () => {
    const on = !speaker;
    await AudioSession.selectAudioOutput(Platform.OS === "ios" ? (on ? "force_speaker" : "default") : (on ? "speaker" : "earpiece"));
    setSpeaker(on);
  });

  const columns = participants.length > 2 ? 2 : 1;
  const status = state === ConnectionState.Connected ? null : state === ConnectionState.Reconnecting ? "Reconnecting…" : "Connecting…";

  return (
    <View style={{ flex: 1 }}>
      {!!status && <Text style={{ color: MUTED, fontSize: 12.5, textAlign: "center", paddingVertical: 6 }}>{status}</Text>}
      <FlatList
        key={columns}
        data={participants}
        numColumns={columns}
        keyExtractor={(p) => p.identity}
        contentContainerStyle={{ padding: 6, flexGrow: 1 }}
        renderItem={({ item: p }) => {
          const ref = cameras.find((c) => c.participant.identity === p.identity);
          const showVideo = !!ref && isTrackReference(ref) && !ref.publication.isMuted;
          const name = p.name || p.identity;
          return (
            <View style={{ flex: 1, minHeight: columns === 1 ? 240 : 180, margin: 4, borderRadius: 12, overflow: "hidden", backgroundColor: "#222", borderWidth: p.isSpeaking ? 2 : 0, borderColor: "#2EA45A" }}>
              {showVideo && ref && isTrackReference(ref) ? (
                <VideoTrack trackRef={ref} style={{ flex: 1 }} />
              ) : (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                  <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: "#3A3A3A", alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ fontSize: 22, fontWeight: "700", color: INK }}>{name.trim().slice(0, 1).toUpperCase()}</Text>
                  </View>
                </View>
              )}
              <View style={{ position: "absolute", left: 8, bottom: 8, right: 8, flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12.5, fontWeight: "600", color: INK, backgroundColor: "rgba(0,0,0,0.5)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                  {p.isLocal ? `${name} (you)` : name}
                </Text>
                {!p.isMicrophoneEnabled && <Text accessibilityLabel="Mic off" style={{ fontSize: 13 }}>🔇</Text>}
              </View>
            </View>
          );
        }}
      />
      {!!note && <Text style={{ color: "#F9A05C", fontSize: 12.5, textAlign: "center", paddingHorizontal: 16, paddingBottom: 6 }}>{note}</Text>}
      <View style={{ flexDirection: "row", justifyContent: "center", flexWrap: "wrap", gap: 10, paddingHorizontal: 12, paddingVertical: 12 }}>
        <Control label={isMicrophoneEnabled ? "Mute" : "Unmute"} on={isMicrophoneEnabled} disabled={!canPublish} onPress={toggleMic} />
        {canPublish && <Control label={isCameraEnabled ? "Camera off" : "Camera on"} on={isCameraEnabled} onPress={toggleCamera} />}
        {canPublish && isCameraEnabled && <Control label="Flip" on={false} onPress={flipCamera} />}
        <Control label={speaker ? "Speaker on" : "Speaker"} on={speaker} onPress={toggleSpeaker} />
      </View>
    </View>
  );
}

function Control({ label, on, disabled, onPress }: { label: string; on: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: 48, minWidth: 88, paddingHorizontal: 16, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: on ? "#fff" : "rgba(255,255,255,0.14)", opacity: disabled ? 0.4 : 1 }}
    >
      <Text style={{ fontSize: 13.5, fontWeight: "600", color: on ? "#111" : INK }}>{label}</Text>
    </TouchableOpacity>
  );
}
