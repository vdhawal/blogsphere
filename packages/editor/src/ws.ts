import type {
  ChangeDelta,
  EditPayload,
  JsonPatchOp,
  ResourceRef,
} from "./types";
import { resourceKey } from "./types";

type Listener<T> = (payload: T) => void;

type ServerMsg =
  | {
      type: "opened";
      resource: ResourceRef;
      content: { kind: "text"; text: string } | { kind: "json"; value: unknown };
      version: number;
    }
  | { type: "ack"; resource: ResourceRef; version: number; clientSeq: number }
  | { type: "closed"; resource: ResourceRef }
  | { type: "error"; code: string; message: string; resource?: ResourceRef };

/**
 * WebSocket client for the unified edit protocol. Every edit — text deltas
 * to markdown, JSON patches to frontmatter or series.yaml — flows through
 * `send` keyed by a `resource` discriminator. Save state is tracked per
 * resource so the spinner is precise: it only stays on while *that* exact
 * resource has in-flight bytes.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private url: string;
  private reconnectTimer: number | null = null;
  private connectedListeners = new Set<Listener<void>>();
  private statusListeners = new Set<Listener<"connecting" | "open" | "closed">>();
  private resourceListeners = new Map<string, Set<Listener<ServerMsg>>>();
  private queue: string[] = [];
  /** In-flight edit count keyed by resource. Spinner = sum > 0. */
  private inflight = new Map<string, number>();
  private inflightListeners = new Set<Listener<Map<string, number>>>();

  constructor(url = `${location.origin.replace(/^http/, "ws")}/ws`) {
    this.url = url;
    this.connect();
  }

  private connect() {
    this.emitStatus("connecting");
    const sock = new WebSocket(this.url);
    this.socket = sock;
    sock.addEventListener("open", () => {
      this.emitStatus("open");
      for (const q of this.queue) sock.send(q);
      this.queue = [];
      for (const l of this.connectedListeners) l();
    });
    sock.addEventListener("close", () => {
      this.emitStatus("closed");
      this.socket = null;
      this.scheduleReconnect();
    });
    sock.addEventListener("error", () => {});
    sock.addEventListener("message", (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.routeMessage(msg);
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  private rawSend(payload: object) {
    const json = JSON.stringify(payload);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(json);
    } else {
      this.queue.push(json);
    }
  }

  private routeMessage(msg: ServerMsg) {
    const r = (msg as { resource?: ResourceRef }).resource;
    const key = r ? resourceKey(r) : null;
    // Both `ack` (success) and `error` (failure) terminate an in-flight
    // delta. Without clearing on error the spinner would stick on "saving"
    // forever after a rejected edit, even though the editor will then
    // re-sync via close+open in the resource listener below.
    if ((msg.type === "ack" || msg.type === "error") && key) {
      this.clearInflight(key);
    }
    if (key) {
      const subs = this.resourceListeners.get(key);
      if (subs) for (const cb of subs) cb(msg);
    }
  }

  // -------- public api --------

  onConnected(cb: Listener<void>): () => void {
    this.connectedListeners.add(cb);
    return () => this.connectedListeners.delete(cb);
  }

  onStatus(cb: Listener<"connecting" | "open" | "closed">): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onInflightChange(cb: Listener<Map<string, number>>): () => void {
    this.inflightListeners.add(cb);
    cb(new Map(this.inflight));
    return () => this.inflightListeners.delete(cb);
  }

  inflightForResource(r: ResourceRef): number {
    return this.inflight.get(resourceKey(r)) ?? 0;
  }

  /** Subscribe to messages for one resource. Returns unsubscriber. */
  subscribe(resource: ResourceRef, cb: Listener<ServerMsg>): () => void {
    const key = resourceKey(resource);
    let subs = this.resourceListeners.get(key);
    if (!subs) {
      subs = new Set();
      this.resourceListeners.set(key, subs);
    }
    subs.add(cb);
    return () => {
      subs?.delete(cb);
      if (subs && subs.size === 0) this.resourceListeners.delete(key);
    };
  }

  open(resource: ResourceRef) {
    this.rawSend({ type: "open", resource });
  }
  close(resource: ResourceRef) {
    this.rawSend({ type: "close", resource });
  }

  sendTextEdit(
    resource: ResourceRef,
    fromVersion: number,
    clientSeq: number,
    changes: ChangeDelta,
  ) {
    this.incrInflight(resourceKey(resource));
    this.rawSend({
      type: "edit",
      resource,
      fromVersion,
      clientSeq,
      edit: { kind: "text", changes } satisfies EditPayload,
    });
  }

  sendJsonEdit(
    resource: ResourceRef,
    fromVersion: number,
    clientSeq: number,
    patches: JsonPatchOp[],
  ) {
    if (patches.length === 0) return;
    this.incrInflight(resourceKey(resource));
    this.rawSend({
      type: "edit",
      resource,
      fromVersion,
      clientSeq,
      edit: { kind: "json", patches } satisfies EditPayload,
    });
  }

  // -------- inflight bookkeeping --------

  private incrInflight(key: string) {
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    this.emitInflight();
  }
  private clearInflight(key: string) {
    // One ack always covers everything earlier on the same resource — the
    // server only sends an ack post-flush, by which point disk is current.
    const cur = this.inflight.get(key) ?? 0;
    this.inflight.set(key, 0);
    if (cur > 0) this.emitInflight();
  }
  private emitInflight() {
    const snap = new Map(this.inflight);
    for (const cb of this.inflightListeners) cb(snap);
  }
  private emitStatus(s: "connecting" | "open" | "closed") {
    for (const cb of this.statusListeners) cb(s);
  }
}

let singleton: WsClient | null = null;
export function getWsClient(): WsClient {
  if (!singleton) singleton = new WsClient();
  return singleton;
}
