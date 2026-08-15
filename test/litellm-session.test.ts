import { strict as assert } from "node:assert";
import { test } from "bun:test";
import install from "../extensions/litellm-session.ts";

type SessionStartHandler = (
  event: unknown,
  ctx: { sessionManager: { getSessionFile: () => string } },
) => Promise<void>;
type BeforeProviderRequestHandler = (
  event: { payload: Record<string, unknown> },
  ctx: { model: { provider: string } },
) => unknown;

test("adds a LiteLLM session ID only to LiteLLM requests", async () => {
  let onSessionStart: SessionStartHandler | undefined;
  let onBeforeProviderRequest: BeforeProviderRequestHandler | undefined;

  install({
    on(event: string, handler: unknown) {
      if (event === "session_start") onSessionStart = handler as SessionStartHandler;
      if (event === "before_provider_request") onBeforeProviderRequest = handler as BeforeProviderRequestHandler;
    },
  } as never);

  if (!onSessionStart || !onBeforeProviderRequest) throw new Error("expected extension handlers");

  await onSessionStart(undefined, {
    sessionManager: {
      getSessionFile: () => "/tmp/2026-08-15T00-12-27-101Z_01a002c3-465d-7407-a180-fe5544ccdd89.jsonl",
    },
  });

  const directPayload = { model: "gpt-5.6-sol" };
  assert.equal(
    onBeforeProviderRequest({ payload: directPayload }, { model: { provider: "openai-codex" } }),
    undefined,
  );

  assert.deepEqual(
    onBeforeProviderRequest({ payload: directPayload }, { model: { provider: "litellm" } }),
    { ...directPayload, litellm_session_id: "01a002c3-465d-7407-a180-fe5544ccdd89" },
  );
});
