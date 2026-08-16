/**
 * Real HTTP servers used by the integration tests.
 *
 * These are not fetch doubles. They are real listeners on real sockets, so the
 * plugin's deadline is exercised through the real transport (undici) rather
 * than through a hand-written promise.
 */
import http from "node:http";
import { AddressInfo } from "node:net";

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

async function listen(server: http.Server): Promise<RunningServer> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * A daemon that answers 200 with headers and then never finishes the body.
 *
 * This is the exact shape the SodaMem SDK cannot bound on its own — it clears
 * its own timer once headers land — so it is the honest end-to-end check that
 * the plugin's deadline covers the whole call.
 */
export async function startStallingDaemon(): Promise<RunningServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"text":"');
    // and never end.
  });
  return listen(server);
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

export interface RecordingProxy extends RunningServer {
  requests: RecordedRequest[];
}

/**
 * A real reverse proxy in front of the real daemon.
 *
 * Used only to read the bytes the plugin puts on the wire. The daemon still
 * receives and really processes every request; nothing is synthesized here.
 */
export async function startRecordingProxy(target: string): Promise<RecordingProxy> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: req.method ?? "", path: req.url ?? "", body });

    const upstream = await fetch(new URL(req.url ?? "/", target), {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([, v]) => typeof v === "string") as [string, string][]
      ),
      body: body === "" ? undefined : body,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(text);
  });
  const running = await listen(server);
  return { ...running, requests };
}
