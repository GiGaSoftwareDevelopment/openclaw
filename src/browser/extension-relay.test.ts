import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  ensureChromeExtensionRelayServer,
  getChromeExtensionRelayAuthHeaders,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";

async function getFreePort(): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const assigned = (s.address() as AddressInfo).port;
        s.close((err) => (err ? reject(err) : resolve(assigned)));
      });
    });
    if (port < 65535) {
      return port;
    }
  }
}

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForError(ws: WebSocket) {
  return new Promise<Error>((resolve, reject) => {
    ws.once("error", (err) => resolve(err instanceof Error ? err : new Error(String(err))));
    ws.once("open", () => reject(new Error("expected websocket error")));
  });
}

function relayAuthHeaders(url: string) {
  return getChromeExtensionRelayAuthHeaders(url);
}

function createMessageQueue(ws: WebSocket) {
  const queue: string[] = [];
  let waiter: ((value: string) => void) | null = null;
  let waiterReject: ((err: Error) => void) | null = null;
  let waiterTimer: NodeJS.Timeout | null = null;

  const flushWaiter = (value: string) => {
    if (!waiter) {
      return false;
    }
    const resolve = waiter;
    waiter = null;
    const reject = waiterReject;
    waiterReject = null;
    if (waiterTimer) {
      clearTimeout(waiterTimer);
    }
    waiterTimer = null;
    if (reject) {
      // no-op (kept for symmetry)
    }
    resolve(value);
    return true;
  };

  ws.on("message", (data) => {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
    if (flushWaiter(text)) {
      return;
    }
    queue.push(text);
  });

  ws.on("error", (err) => {
    if (!waiterReject) {
      return;
    }
    const reject = waiterReject;
    waiterReject = null;
    waiter = null;
    if (waiterTimer) {
      clearTimeout(waiterTimer);
    }
    waiterTimer = null;
    reject(err instanceof Error ? err : new Error(String(err)));
  });

  const next = (timeoutMs = 5000) =>
    new Promise<string>((resolve, reject) => {
      const existing = queue.shift();
      if (existing !== undefined) {
        return resolve(existing);
      }
      waiter = resolve;
      waiterReject = reject;
      waiterTimer = setTimeout(() => {
        waiter = null;
        waiterReject = null;
        waiterTimer = null;
        reject(new Error("timeout"));
      }, timeoutMs);
    });

  return { next };
}

async function waitForListMatch<T>(
  fetchList: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await fetchList();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("timeout waiting for list update");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("chrome extension relay server", () => {
  let cdpUrl = "";

  afterEach(async () => {
    if (cdpUrl) {
      await stopChromeExtensionRelayServer({ cdpUrl }).catch(() => {});
      cdpUrl = "";
    }
  });

  it("advertises CDP WS only when extension is connected", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const v1 = (await fetch(`${cdpUrl}/json/version`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(v1.webSocketDebuggerUrl).toBeUndefined();

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    const v2 = (await fetch(`${cdpUrl}/json/version`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(String(v2.webSocketDebuggerUrl ?? "")).toContain(`/cdp`);

    ext.close();
  });

  it("rejects CDP access without relay auth token", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const res = await fetch(`${cdpUrl}/json/version`);
    expect(res.status).toBe(401);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
    const err = await waitForError(cdp);
    expect(err.message).toContain("401");
  });

  it("tracks attached page targets and exposes them via CDP + /json/list", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    // Simulate a tab attach coming from the extension.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-1",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "Example",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const list = (await fetch(`${cdpUrl}/json/list`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as Array<{
      id?: string;
      url?: string;
      title?: string;
    }>;
    expect(list.some((t) => t.id === "t1" && t.url === "https://example.com")).toBe(true);

    // Simulate navigation updating tab metadata.
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.targetInfoChanged",
          params: {
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "DER STANDARD",
              url: "https://www.derstandard.at/",
            },
          },
        },
      }),
    );

    const list2 = await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{
          id?: string;
          url?: string;
          title?: string;
        }>,
      (list) =>
        list.some(
          (t) =>
            t.id === "t1" && t.url === "https://www.derstandard.at/" && t.title === "DER STANDARD",
        ),
    );
    expect(
      list2.some(
        (t) =>
          t.id === "t1" && t.url === "https://www.derstandard.at/" && t.title === "DER STANDARD",
      ),
    ).toBe(true);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    const res1 = JSON.parse(await q.next()) as { id: number; result?: unknown };
    expect(res1.id).toBe(1);
    expect(JSON.stringify(res1.result ?? {})).toContain("t1");

    cdp.send(
      JSON.stringify({
        id: 2,
        method: "Target.attachToTarget",
        params: { targetId: "t1" },
      }),
    );
    const received: Array<{
      id?: number;
      method?: string;
      result?: unknown;
      params?: unknown;
    }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const res2 = received.find((m) => m.id === 2);
    expect(res2?.id).toBe(2);
    expect(JSON.stringify(res2?.result ?? {})).toContain("cb-tab-1");

    const evt = received.find((m) => m.method === "Target.attachedToTarget");
    expect(evt?.method).toBe("Target.attachedToTarget");
    expect(JSON.stringify(evt?.params ?? {})).toContain("t1");

    cdp.close();
    ext.close();
  }, 15_000);

  it("rebroadcasts attach when a session id is reused for a new target", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "First",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const first = JSON.parse(await q.next()) as { method?: string; params?: unknown };
    expect(first.method).toBe("Target.attachedToTarget");
    expect(JSON.stringify(first.params ?? {})).toContain("t1");

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t2",
              type: "page",
              title: "Second",
              url: "https://example.org",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const received: Array<{ method?: string; params?: unknown }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const detached = received.find((m) => m.method === "Target.detachedFromTarget");
    const attached = received.find((m) => m.method === "Target.attachedToTarget");
    expect(JSON.stringify(detached?.params ?? {})).toContain("t1");
    expect(JSON.stringify(attached?.params ?? {})).toContain("t2");

    cdp.close();
    ext.close();
  });

  it("includes discovered tabs in /json/list", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    // Send tab discovery
    ext.send(
      JSON.stringify({
        method: "tabsDiscovered",
        params: {
          tabs: [
            { tabId: 100, title: "Google", url: "https://google.com", active: true },
            { tabId: 101, title: "GitHub", url: "https://github.com", active: false },
          ],
        },
      }),
    );

    // Give relay time to process
    await new Promise((r) => setTimeout(r, 100));

    const list = (await fetch(`${cdpUrl}/json/list`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as Array<{ id?: string; title?: string; url?: string }>;

    expect(list.some((t) => t.id === "dtab-100" && t.title === "Google")).toBe(true);
    expect(list.some((t) => t.id === "dtab-101" && t.title === "GitHub")).toBe(true);

    ext.close();
  });

  it("updates discovered tabs on lifecycle events", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    // Initial discovery
    ext.send(
      JSON.stringify({
        method: "tabsDiscovered",
        params: {
          tabs: [{ tabId: 200, title: "Old Title", url: "https://example.com", active: false }],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // Update title/url
    ext.send(
      JSON.stringify({
        method: "tabUpdated",
        params: { tabId: 200, title: "New Title", url: "https://example.com/page", active: false },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    let list = (await fetch(`${cdpUrl}/json/list`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as Array<{ id?: string; title?: string; url?: string }>;

    expect(
      list.some(
        (t) =>
          t.id === "dtab-200" && t.title === "New Title" && t.url === "https://example.com/page",
      ),
    ).toBe(true);

    // Remove tab
    ext.send(JSON.stringify({ method: "tabRemoved", params: { tabId: 200 } }));
    await new Promise((r) => setTimeout(r, 50));

    list = (await fetch(`${cdpUrl}/json/list`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as Array<{ id?: string }>;

    expect(list.some((t) => t.id === "dtab-200")).toBe(false);

    ext.close();
  });

  it("does not duplicate attached tabs in /json/list", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    // Discover tab
    ext.send(
      JSON.stringify({
        method: "tabsDiscovered",
        params: {
          tabs: [{ tabId: 300, title: "Example", url: "https://example.com", active: true }],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // Also attach the same tab (simulates manual click)
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-1",
            targetInfo: {
              targetId: "real-t1",
              type: "page",
              title: "Example",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const list = (await fetch(`${cdpUrl}/json/list`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as Array<{ id?: string; title?: string }>;

    // Should have the attached version (real-t1), not the discovered version (dtab-300)
    const exampleTabs = list.filter((t) => t.title === "Example");
    expect(exampleTabs.length).toBe(1);
    expect(exampleTabs[0]?.id).toBe("real-t1");

    ext.close();
  });

  it("auto-attaches a discovered tab via /json/attach", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);
    const q = createMessageQueue(ext);

    // Discover tabs
    ext.send(
      JSON.stringify({
        method: "tabsDiscovered",
        params: {
          tabs: [{ tabId: 400, title: "Target Tab", url: "https://target.com", active: false }],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // Request auto-attach — this runs async, so we need to handle the extension's side
    const attachPromise = fetch(`${cdpUrl}/json/attach/dtab-400`, {
      method: "POST",
      headers: relayAuthHeaders(cdpUrl),
    });

    // Extension receives attachDiscoveredTab command
    const extMsg = JSON.parse(await q.next()) as {
      id: number;
      method: string;
      params?: { tabId?: number };
    };
    // Skip pings
    let msg = extMsg;
    while (msg.method === "ping") {
      ext.send(JSON.stringify({ method: "pong" }));
      msg = JSON.parse(await q.next()) as typeof extMsg;
    }

    expect(msg.method).toBe("attachDiscoveredTab");
    expect(msg.params?.tabId).toBe(400);

    // Simulate successful attach
    ext.send(
      JSON.stringify({
        id: msg.id,
        result: { sessionId: "cb-tab-10", targetId: "real-target-400" },
      }),
    );

    // Also send the Target.attachedToTarget event (as the real extension would)
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-10",
            targetInfo: {
              targetId: "real-target-400",
              type: "page",
              title: "Target Tab",
              url: "https://target.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const attachRes = await attachPromise;
    expect(attachRes.status).toBe(200);
    const body = (await attachRes.json()) as { targetId?: string; sessionId?: string };
    expect(body.targetId).toBe("real-target-400");
    expect(body.sessionId).toBe("cb-tab-10");

    ext.close();
  });

  it("clears discovered tabs when extension disconnects", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext);

    ext.send(
      JSON.stringify({
        method: "tabsDiscovered",
        params: { tabs: [{ tabId: 500, title: "Tab", url: "https://example.com", active: false }] },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    let list = (await fetch(`${cdpUrl}/json/list`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as Array<{ id?: string }>;
    expect(list.some((t) => t.id === "dtab-500")).toBe(true);

    // Disconnect extension
    ext.close();
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect new extension (no tabs yet)
    const ext2 = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    await waitForOpen(ext2);

    list = (await fetch(`${cdpUrl}/json/list`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as Array<{ id?: string }>;
    expect(list.some((t) => t.id === "dtab-500")).toBe(false);

    ext2.close();
  });
});
