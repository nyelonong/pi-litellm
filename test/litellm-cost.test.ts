import { strict as assert } from "node:assert";
import { test } from "bun:test";
import install from "../extensions/litellm-cost.ts";

type SessionStartHandler = (
  event: unknown,
  ctx: { ui: { notify: (message: string, level: string) => void } },
) => Promise<void>;

test("does not warn when LiteLLM pricing metadata is unavailable", async () => {
  let onSessionStart: SessionStartHandler | undefined;
  const originalFetch = globalThis.fetch;
  const notifications: Array<{ message: string; level: string }> = [];

  globalThis.fetch = (async () => {
    throw new Error("fetch failed");
  }) as typeof fetch;

  try {
    install({
      on(event: string, handler: unknown) {
        if (event === "session_start") onSessionStart = handler as SessionStartHandler;
      },
    } as never);

    if (!onSessionStart) throw new Error("expected session_start handler");

    await onSessionStart(undefined, {
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    });

    assert.deepEqual(notifications, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
