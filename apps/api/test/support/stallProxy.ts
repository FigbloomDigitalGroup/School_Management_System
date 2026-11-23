import net from "node:net";

/** A TCP proxy to PostgreSQL that can be stalled: sockets stay open, no bytes move. */
export class StallProxy {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  private stalled = false;
  port = 0;

  constructor(private target: { host: string; port: number }) {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.target.port, this.target.host);
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on("close", () => this.sockets.delete(s));
        s.on("error", () => s.destroy());
      }
      client.pipe(upstream);
      upstream.pipe(client);
      if (this.stalled) {
        client.pause();
        upstream.pause();
      }
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  stall(): void {
    this.stalled = true;
    for (const s of this.sockets) s.pause();
  }

  resume(): void {
    this.stalled = false;
    for (const s of this.sockets) s.resume();
  }

  /** Number of currently open client-side connections (a leaked pool client keeps one open). */
  get open(): number {
    return this.sockets.size / 2;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function viaProxy(runtimeUrl: string, port: number): string {
  const u = new URL(runtimeUrl);
  u.hostname = "127.0.0.1";
  u.port = String(port);
  return u.toString();
}

