export interface LiveKitTokenRequest {
  tenantId: string;
  roomName: string;
  participantIdentity: string;
  participantName: string;
  role: "host" | "participant";
}

export type LiveKitTokenResult =
  | { status: "ready"; url: string; token: string; roomName: string }
  | { status: "not_configured"; reason: "livekit_provider_not_configured"; roomName: string };

/**
 * Provider-neutral remote-learning / LiveKit room-token boundary.
 * Never fabricates live tokens when no LiveKit server is configured.
 */
export interface LiveKitProvider {
  readonly configured: boolean;
  createRoomToken(req: LiveKitTokenRequest): Promise<LiveKitTokenResult>;
}

export class NotConfiguredLiveKitProvider implements LiveKitProvider {
  readonly configured = false;

  async createRoomToken(req: LiveKitTokenRequest): Promise<LiveKitTokenResult> {
    return {
      status: "not_configured",
      reason: "livekit_provider_not_configured",
      roomName: req.roomName,
    };
  }
}

let activeLiveKitProvider: LiveKitProvider = new NotConfiguredLiveKitProvider();

export function getLiveKitProvider(): LiveKitProvider {
  return activeLiveKitProvider;
}

export function setLiveKitProviderForTesting(provider: LiveKitProvider): void {
  activeLiveKitProvider = provider;
}
