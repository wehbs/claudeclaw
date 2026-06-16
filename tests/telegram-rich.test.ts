import { test, expect, afterEach } from "bun:test";
import { isMethodNotFound, callRichApi, sendRichMessage } from "../src/commands/telegram";

// Rich-message support (Bot API 10.1) is gated by a per-session capability latch:
// rich is disabled for the session ONLY on a definitive method-not-found, while
// transient/content errors fall back for one message and retry rich next time.
// These tests lock down the two pieces that decision rests on — the error
// classifier and the rich API call's ok:false handling — plus the request shape.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(body: object, status: number, statusText?: string): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, statusText })) as unknown as typeof fetch;
}

// --- isMethodNotFound: decides latch-off (404) vs retry (everything else) ---

test("isMethodNotFound: clean HTTP 404 → true (latch rich off for the session)", () => {
  expect(isMethodNotFound(new Error("Telegram API sendRichMessage: 404 Not Found"))).toBe(true);
});

test("isMethodNotFound: 'method not found' description → true", () => {
  expect(
    isMethodNotFound(new Error("Telegram API sendRichMessage: 200 OK 404 Not Found: method not found")),
  ).toBe(true);
});

test("isMethodNotFound: 400 content error → false (transient, retry rich next time)", () => {
  expect(
    isMethodNotFound(new Error("Telegram API sendRichMessage: 400 Bad Request: message text is empty")),
  ).toBe(false);
});

test("isMethodNotFound: 429 rate limit → false (do not latch on transient)", () => {
  expect(isMethodNotFound(new Error("Telegram API sendRichMessage: 429 Too Many Requests"))).toBe(false);
});

test("isMethodNotFound: network failure → false (do not latch on transient)", () => {
  expect(isMethodNotFound(new Error("fetch failed"))).toBe(false);
});

test("isMethodNotFound: does not match a 404 embedded in a larger number", () => {
  // \b404\b must not fire on e.g. a 4040x id, otherwise an unrelated error could
  // wrongly disable rich for the whole session.
  expect(isMethodNotFound(new Error("Telegram API sendRichMessage: 400 update_id 14049 failed"))).toBe(false);
});

test("isMethodNotFound: tolerates non-Error values", () => {
  expect(isMethodNotFound("boom 404")).toBe(true);
  expect(isMethodNotFound(null)).toBe(false);
  expect(isMethodNotFound(undefined)).toBe(false);
});

// --- callRichApi: the silent-drop guard. A not-yet-GA rich method can answer
// HTTP 200 with {ok:false}; trusting the status alone would drop the message. ---

test("callRichApi: HTTP 200 but {ok:false} → throws (no silent success)", async () => {
  mockFetch({ ok: false, error_code: 404, description: "Not Found: method not found" }, 200, "OK");
  let err: unknown;
  try {
    await callRichApi("TOKEN", "sendRichMessage", { chat_id: 1, rich_message: { markdown: "# hi" } });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  // error_code is surfaced into the message, so the latch decision still fires
  expect(isMethodNotFound(err)).toBe(true);
});

test("callRichApi: clean HTTP 404 → throws, flagged method-not-found", async () => {
  mockFetch({ ok: false, error_code: 404, description: "Not Found: method not found" }, 404, "Not Found");
  let err: unknown;
  try {
    await callRichApi("TOKEN", "sendRichMessage", { chat_id: 1, rich_message: { markdown: "x" } });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect(isMethodNotFound(err)).toBe(true);
});

test("callRichApi: HTTP 400 content error → throws, NOT method-not-found (rich retries)", async () => {
  mockFetch({ ok: false, error_code: 400, description: "Bad Request: can't parse markdown" }, 400, "Bad Request");
  let err: unknown;
  try {
    await callRichApi("TOKEN", "sendRichMessage", { chat_id: 1, rich_message: { markdown: "x" } });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect(isMethodNotFound(err)).toBe(false);
});

test("callRichApi: HTTP 200 {ok:true} → resolves (rich send succeeded)", async () => {
  mockFetch({ ok: true, result: { message_id: 5 } }, 200, "OK");
  await expect(
    callRichApi("TOKEN", "sendRichMessage", { chat_id: 1, rich_message: { markdown: "x" } }),
  ).resolves.toBeUndefined();
});

// --- sendRichMessage: request shape matches the Bot API 10.1 schema ---

test("sendRichMessage: posts markdown + preserves topic-thread routing", async () => {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, opts: { body: string }) => {
    captured = JSON.parse(opts.body);
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, statusText: "OK" });
  }) as unknown as typeof fetch;

  await sendRichMessage("TOKEN", 42, "# Heading\n\n| a | b |\n|---|---|", 415);

  expect(captured.chat_id).toBe(42);
  expect(captured.message_thread_id).toBe(415); // topic routing must survive
  expect(captured.rich_message).toEqual({ markdown: "# Heading\n\n| a | b |\n|---|---|" });
  // InputRichMessage requires EXACTLY ONE of markdown | html
  expect("html" in (captured.rich_message as object)).toBe(false);
});

test("sendRichMessage: omits message_thread_id when there is no thread", async () => {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, opts: { body: string }) => {
    captured = JSON.parse(opts.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" });
  }) as unknown as typeof fetch;

  await sendRichMessage("TOKEN", 7, "plain");

  expect(captured.chat_id).toBe(7);
  expect("message_thread_id" in captured).toBe(false);
});
