import type { FastifyInstance } from "fastify";
import { ValidationError, VersionMismatchError, type Store, type SubscriberHandle } from "./store.js";
import { validateJsonPatches, validateTextDelta } from "./edits.js";
import { resourceKey, type ResourceRef, type WsClientMessage, type WsServerMessage } from "./types.js";

let subIdCounter = 0;

export function registerWebsocket(app: FastifyInstance, store: Store): void {
  app.get("/ws", { websocket: true }, (socket) => {
    const subId = ++subIdCounter;
    const openedHere = new Map<string, ResourceRef>();
    const handle: SubscriberHandle = {
      id: subId,
      send: (msg) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      },
    };

    type ErrCode = Extract<WsServerMessage, { type: "error" }>["code"];
    const sendError = (code: ErrCode, message: string, resource?: WsClientMessage["resource"]) =>
      handle.send({ type: "error", code, message, resource } satisfies WsServerMessage);

    socket.on("message", async (raw: Buffer) => {
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsClientMessage;
      } catch {
        sendError("invalid-edit", "malformed JSON");
        return;
      }

      app.log.debug({ sub: subId, ws: msg }, "ws inbound");

      try {
        switch (msg.type) {
          case "open": {
            const snap = await store.open(msg.resource, handle);
            openedHere.set(resourceKey(msg.resource), msg.resource);
            handle.send({
              type: "opened",
              resource: msg.resource,
              content: snap.kind === "text" ? { kind: "text", text: snap.text } : { kind: "json", value: snap.value },
              version: snap.version,
            } satisfies WsServerMessage);
            break;
          }
          case "close": {
            await store.close(msg.resource, handle);
            openedHere.delete(resourceKey(msg.resource));
            handle.send({ type: "closed", resource: msg.resource } satisfies WsServerMessage);
            break;
          }
          case "edit": {
            const valid =
              msg.edit.kind === "text"
                ? validateTextDelta(msg.edit.changes)
                : validateJsonPatches(msg.edit.patches);
            if (!valid) {
              sendError("invalid-edit", "malformed edit payload", msg.resource);
              return;
            }
            try {
              store.applyEdit(msg.resource, msg.fromVersion, msg.edit, msg.clientSeq, handle);
              // Ack emitted after flush, not here.
            } catch (err) {
              if (err instanceof VersionMismatchError) {
                sendError("version-mismatch", err.message, msg.resource);
              } else if (err instanceof ValidationError) {
                sendError("validation-failed", err.message, msg.resource);
              } else {
                sendError("invalid-edit", (err as Error).message, msg.resource);
              }
            }
            break;
          }
          default:
            sendError("invalid-edit", "unknown message type");
        }
      } catch (err) {
        sendError("internal", (err as Error).message);
      }
    });

    socket.on("close", async () => {
      // Force a flush of anything this socket left open.
      for (const r of openedHere.values()) {
        try {
          await store.close(r, handle);
        } catch {
          /* already evicted */
        }
      }
    });
  });
}
