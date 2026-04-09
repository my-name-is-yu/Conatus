import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../daemon-client.js";
import { EventServer } from "../event-server.js";
import { OutboxStore } from "../store/outbox-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

function createMockDriveSystem() {
  return {
    writeEvent: async () => undefined,
  };
}

function waitForEvent(
  client: DaemonClient,
  eventName: string,
  timeoutMs = 2000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for client event: ${eventName}`));
    }, timeoutMs);

    const onEvent = (data: unknown) => {
      clearTimeout(timeout);
      client.off(eventName, onEvent);
      resolve(data);
    };

    client.on(eventName, onEvent);
  });
}

describe("DaemonClient snapshot + replay", () => {
  let tmpDir: string;
  let server: EventServer;

  beforeEach(() => {
    tmpDir = makeTempDir();
    server = new EventServer(createMockDriveSystem() as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      outboxStore: new OutboxStore(tmpDir),
    });
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
    cleanupTempDir(tmpDir);
  });

  it("replays events that were missed while disconnected", async () => {
    await server.start();

    const daemonStatePath = path.join(tmpDir, "daemon-state.json");
    fs.writeFileSync(daemonStatePath, JSON.stringify({ status: "running", pid: process.pid }), "utf-8");

    await server.broadcast("daemon_status", { status: "running", loopCount: 1 });

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      reconnectInterval: 50,
      maxReconnectAttempts: 2,
    });

    try {
      client.connect();
      await waitForEvent(client, "_connected");

      client.disconnect();

      const replayed = waitForEvent(client, "chat_message_received");
      await server.broadcast("chat_message_received", { goalId: "goal-1", message: "missed while offline" });

      client.connect();

      await expect(replayed).resolves.toEqual({
        goalId: "goal-1",
        message: "missed while offline",
      });
    } finally {
      client.disconnect();
    }
  });
});
