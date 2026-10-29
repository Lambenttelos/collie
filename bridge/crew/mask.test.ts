// The lead masks a member's text answer before the phone reads it (CREW_PROTOCOL.md §9.1): a member
// one release behind sends its text in clear, and a lead that masks must not pass that on. Driven
// through `forwardToPeer` with the real mask, so each case is "what the phone gets through the lead".
// Placeholders only: the fake key is built at run time, so no key shape sits in this file.
import { describe, expect, test } from "bun:test";

import { maskChatBody, maskClearReceipt, maskConversationRows, maskDiff, maskFileBody, maskHistoryPage, maskPaneRead, maskSendAnswer, maskSnapshotPanes, maskTodoList } from "../answer-mask.ts";
import { muxOk, type MuxConversationPage } from "../mux/types.ts";
import { durableConversations } from "../server.ts";
import type { ChatWindowBody } from "../journal/live.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import type { ChangeDiff, FileReadAnswer, PaneReadResponse, PaneWire, SnapshotResponse } from "../types.ts";
import type { HoldNote } from "../../web/src/lib/surface/hold.ts";
import type { HeldRow } from "../../web/src/lib/surface/send.ts";
import type { Ask, Surface } from "../../web/src/lib/surface/surface.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";
import { forwardToPeer, saltTag, textAnswerOf, unsaltIfNoneMatch, type ForwardDeps, type ForwardTransport } from "./forward.ts";
import { maskForwardedAnswer } from "./mask.ts";
import type { CrewLink, PeerOutcome } from "./peer-client.ts";
import type { PeerState } from "./registry.ts";
import { mergeSnapshot, parsePeerSnapshot, type PeerSnapshotWire } from "./merge.ts";

const key = `sk-test-placeholder-${"0".repeat(40)}`;
const masked = `sk-t${"•".repeat(key.length - 4)}`;
const blobUrl = `/api/blobs/${"ab".repeat(32)}`;
const dataUrl = `data:image/png;base64,iVBORw0KGgo${"A".repeat(40)}==`;
const ETAG = '"the-members-own-tag"';
/** The member's tag as the phone gets it through a lead that masks: salted with the mask's version. */
const SALTED = saltTag(ETAG);

const LINK: CrewLink = { memberId: "laptop", address: "laptop.example:8787" };
const REACHABLE: PeerState = {
  memberId: "laptop",
  health: "reachable",
  lastSeenAt: 1_754_000_000_000,
  reason: null,
  version: "1.17.2",
  conflict: null,
  preflight: null,
};

/** The member answers `body` with `status`, its own ETag, as JSON; `pulls` counts reads of the body. */
function member(body: string | Uint8Array | null, status = 200, contentType = "application/json; charset=utf-8") {
  const seen = { pulls: 0, headers: new Headers() };
  const transport: ForwardTransport = async (_link, _route, _params, init) => {
    seen.headers = new Headers(init.headers);
    const stream =
      body === null
        ? null
        : new ReadableStream<Uint8Array>({
            pull(controller) {
              seen.pulls += 1;
              controller.enqueue(typeof body === "string" ? new TextEncoder().encode(body) : body);
              controller.close();
            },
            // No read ahead: `pull` runs only when somebody reads, so `pulls` says who did.
          }, { highWaterMark: 0 });
    const res = new Response(stream, { status, headers: { "content-type": contentType, etag: ETAG } });
    const out: PeerOutcome<Response> = { ok: true, value: res, status, member: "laptop", receivedAt: 1, date: null };
    return out;
  };
  return { transport, seen };
}

/** One request through the lead, the mask on unless `mask` says otherwise; a `body` makes it a POST. */
function viaLead(
  path: string,
  transport: ForwardTransport,
  opts: { mask?: ForwardDeps["mask"]; headers?: Record<string, string>; body?: string } = { mask: maskForwardedAnswer },
) {
  const url = new URL(`https://lead.example${path}${path.includes("?") ? "&" : "?"}host=laptop`);
  const headers = opts.headers ?? {};
  const init: RequestInit = opts.body === undefined ? { headers } : { method: "POST", headers, body: opts.body };
  return forwardToPeer(new Request(url, init), url, {
    link: LINK,
    state: REACHABLE,
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    transport,
    mask: opts.mask,
  });
}

const entry: TranscriptEntry = {
  uuid: "u-1",
  ts: "2026-10-08T00:00:00Z",
  role: "assistant",
  parts: [
    { kind: "text", text: `the key is ${key}` },
    {
      kind: "tool",
      name: "Bash",
      id: "toolu_01",
      summary: `export OPENAI_API_KEY=${key}`,
      call: { kind: "execute", command: `curl -H "x-key: ${key}"` },
      result: { text: `echoed ${key}` },
    },
    { kind: "image", url: blobUrl, mimeType: "image/png" },
    { kind: "image", url: dataUrl, mimeType: "image/png" },
  ],
};

// What a member on 1.17 sends for each answer: the same shapes, in clear.
const paneRead: PaneReadResponse = { paneId: "w1:p1", text: `\u001b[2m$ cat .env\u001b[0m\nKEY=${key}\n`, truncated: false, revision: 7 };
const history = { paneId: "w1:p1", available: true as const, entries: [entry], hasMore: false, total: 1, fileTruncated: false };
const chatBody: ChatWindowBody = {
  page: "live",
  gen: 1,
  session: "s1",
  rev: 3,
  head: 1_000_001,
  oldest: 1_000_000,
  hasOlder: false,
  upserts: [{ ...entry, seq: 1_000_001 }],
  queued: [`use ${key} next`],
};
const chat = { paneId: "w1:p1", available: true as const, ...chatBody };
const diff: ChangeDiff = {
  available: true,
  repo: ".",
  path: ".env",
  status: "M",
  binary: false,
  directory: false,
  truncated: false,
  diff: `@@ -1 +1 @@\n-KEY=old\n+KEY=${key}\n`,
};
const fileText: FileReadAnswer = { available: true, root: "/home/a/p", path: ".env", size: 80, binary: false, truncated: false, text: `KEY=${key}\n` };
// A Surface that read a permission dialog: its option labels are rows of the screen.
const ask: Ask = { id: "ask-0123456789abcd", kind: "permission", options: [{ id: "1", label: "Yes" }, { id: "2", label: `Yes, and use ${key}` }], channel: "keys", hash: "0abc12" };
const surface: Surface = { revision: 4, turn: "idle", modal: { ask }, composer: "unknown" };
// A reply the Send Protocol refused on that screen (M56 spec 06), as a member that does not mask answers it.
const reply = {
  ok: false,
  textDelivered: false,
  error: "The input box is not free.",
  code: "reply.send_failed",
  send: { receipt: { requestId: "phone-req-0001", outcome: "refused", reason: "not_free" }, surface, offers: ["keys"] },
};
// A durable program's conversation list (M53 spec 11): the titles and subtitles are the program's words.
const conversations = {
  available: true,
  items: [
    { id: "conv-1", title: `Ticket ${key}`, subtitle: `about ${key}`, startedAt: "2026-10-13T09:00:00.000Z", state: "open", items: 2, paneId: "conv-1" },
    { id: "conv-2", title: "Plain words", startedAt: "2026-10-12T09:00:00.000Z", state: "closed", items: 1 },
  ],
  next: "c1",
};

describe("which answers the lead masks", () => {
  test("the mirror, History, Chat, Changes and Files, by pane and by space, the conversation list, a reply and a Clear's receipt; never a picture or a blob", () => {
    expect(textAnswerOf("pane/w1%3Ap1")).toBe("pane");
    expect(textAnswerOf("pane/w1%3Ap1/history")).toBe("history");
    expect(textAnswerOf("pane/w1%3Ap1/chat")).toBe("chat");
    expect(textAnswerOf("pane/w1%3Ap1/changes")).toBe("changes");
    expect(textAnswerOf("workspace/w1/changes")).toBe("changes");
    expect(textAnswerOf("pane/w1%3Ap1/files")).toBe("files");
    expect(textAnswerOf("workspace/w1/files")).toBe("files");
    expect(textAnswerOf("durable/conversations")).toBe("conversations");
    expect(textAnswerOf("pane/w1%3Ap1/reply")).toBe("reply");
    expect(textAnswerOf("pane/w1%3Ap1/clear")).toBe("clear");
    for (const route of ["pane/w1/files/image", "workspace/w1/files/image", `blobs/${"ab".repeat(32)}`, "launchers", "folders", "pane/w1/keys", "pane/w1/answer", "pane/w1/send", "durable/conversation/c1/reopen", "tab"]) {
      expect(textAnswerOf(route)).toBeNull();
    }
  });
});

describe("a member's key reaches the phone masked through the lead", () => {
  const cases: [string, string, string][] = [
    ["the mirror", "/api/pane/w1:p1", JSON.stringify(paneRead)],
    ["a History page", "/api/pane/w1:p1/history", JSON.stringify(history)],
    ["a Chat window", "/api/pane/w1:p1/chat", JSON.stringify(chat)],
    ["a Chat older page", "/api/pane/w1:p1/chat", JSON.stringify({ paneId: "w1:p1", available: true, page: "older", gen: 1, upserts: [{ ...entry, seq: 999_999 }], hasOlder: false })],
    ["a Changes diff", "/api/pane/w1:p1/changes", JSON.stringify({ paneId: "w1:p1", ...diff })],
    ["a Changes diff asked by space", "/api/workspace/w1/changes", JSON.stringify({ workspaceId: "w1", ...diff })],
    ["a Files body", "/api/pane/w1:p1/files", JSON.stringify({ paneId: "w1:p1", ...fileText })],
    ["a Files body asked by space", "/api/workspace/w1/files", JSON.stringify({ workspaceId: "w1", ...fileText })],
    ["a durable program's conversation list", "/api/durable/conversations", JSON.stringify(conversations)],
  ];
  for (const [name, path, body] of cases) {
    test(name, async () => {
      expect(body).toContain(key);
      const res = await viaLead(path, member(body).transport);
      expect(res.status).toBe(200);
      const out = await res.text();
      expect(out).not.toContain(key);
      expect(out).toContain(masked);
      // The member's tag rides on, salted, so the member keeps answering the phone's If-None-Match.
      expect(res.headers.get("etag")).toBe(SALTED);
    });
  }

  test("ids, kinds and both picture addresses survive, and nothing is added or dropped", async () => {
    const res = await viaLead("/api/pane/w1:p1/history", member(JSON.stringify(history)).transport);
    // SAFETY: the lead re-serialised a History page; the assertions below read it field by field.
    const page = (await res.json()) as typeof history;
    const parts = page.entries[0]!.parts;
    expect(parts.map((p) => p.kind)).toEqual(["text", "tool", "image", "image"]);
    expect(parts[1]!.kind === "tool" && parts[1]!.id).toBe("toolu_01");
    expect(parts[2]).toEqual({ kind: "image", url: blobUrl, mimeType: "image/png" });
    expect(parts[3]).toEqual({ kind: "image", url: dataUrl, mimeType: "image/png" });
    expect(page.entries[0]!.uuid).toBe("u-1");
    expect(page.total).toBe(1);
  });

  test("the mirror keeps its escapes and its width", async () => {
    const res = await viaLead("/api/pane/w1:p1", member(JSON.stringify(paneRead)).transport);
    // SAFETY: the lead re-serialised a mirror read; `text` and `revision` are asserted below.
    const read = (await res.json()) as PaneReadResponse;
    expect(read.text).toHaveLength(paneRead.text.length);
    expect(read.text.startsWith("\u001b[2m$ cat .env\u001b[0m\n")).toBe(true);
    expect(read.revision).toBe(7);
  });

  test("the lead masks exactly what a 1.18 member masks: the same functions, the same bytes", () => {
    expect(maskForwardedAnswer("pane", JSON.stringify(paneRead))).toBe(JSON.stringify(maskPaneRead(paneRead)));
    expect(maskForwardedAnswer("history", JSON.stringify(history))).toBe(JSON.stringify(maskHistoryPage(history)));
    expect(maskForwardedAnswer("chat", JSON.stringify(chat))).toBe(JSON.stringify(maskChatBody(chat)));
    expect(maskForwardedAnswer("changes", JSON.stringify(diff))).toBe(JSON.stringify(maskDiff(diff, true)));
    expect(maskForwardedAnswer("files", JSON.stringify(fileText))).toBe(JSON.stringify(maskFileBody(fileText, true)));
    const clearReceipt = { requestId: "clear-req-0001", outcome: "cleared", draft: `export OPENAI_API_KEY=${key}` };
    expect(maskForwardedAnswer("clear", JSON.stringify(clearReceipt))).toBe(JSON.stringify(maskClearReceipt(clearReceipt)));
    expect(maskForwardedAnswer("reply", JSON.stringify(reply))).toBe(JSON.stringify({ ...reply, send: maskSendAnswer(reply.send) }));
    expect(maskForwardedAnswer("conversations", JSON.stringify(conversations))).toBe(JSON.stringify({ ...conversations, items: maskConversationRows(conversations.items) }));
  });

  test("the phone asked for gzip: the masked bytes are what is compressed", async () => {
    const res = await viaLead("/api/pane/w1:p1/chat", member(JSON.stringify(chat)).transport, {
      mask: maskForwardedAnswer,
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const out = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(out).not.toContain(key);
    expect(out).toContain(masked);
  });
});

describe("an answer a 1.18 member already masked comes back byte for byte", () => {
  const already: [string, string, string][] = [
    ["the mirror", "/api/pane/w1:p1", JSON.stringify(maskPaneRead(paneRead))],
    ["a History page", "/api/pane/w1:p1/history", JSON.stringify(maskHistoryPage(history))],
    ["a Chat window", "/api/pane/w1:p1/chat", JSON.stringify(maskChatBody(chat))],
    ["a Changes diff", "/api/pane/w1:p1/changes", JSON.stringify({ paneId: "w1:p1", ...maskDiff(diff, true) })],
    ["a Files body", "/api/pane/w1:p1/files", JSON.stringify({ paneId: "w1:p1", ...maskFileBody(fileText, true) })],
    ["a conversation list", "/api/durable/conversations", JSON.stringify({ ...conversations, items: maskConversationRows(conversations.items) })],
  ];
  for (const [name, path, body] of already) {
    test(name, async () => {
      expect(body).not.toContain(key);
      const res = await viaLead(path, member(body).transport);
      expect(await res.text()).toBe(body);
      expect(res.headers.get("etag")).toBe(SALTED);
    });
  }

  test("an answer with nothing to mask is the member's own bytes, not a re-serialisation", () => {
    // Spacing a re-serialisation would drop: proof the bytes were handed back, not rebuilt.
    const unavailable = '{"paneId":"w1:p1", "available":false, "reason":"no-session"}';
    expect(maskForwardedAnswer("history", unavailable)).toBe(unavailable);
    expect(maskForwardedAnswer("chat", unavailable)).toBe(unavailable);
    const listing = '{"paneId":"w1:p1", "available":true, "root":"/r", "dir":"", "entries":[], "truncated":false}';
    expect(maskForwardedAnswer("files", listing)).toBe(listing);
    const changes = '{"paneId":"w1:p1", "available":true, "root":"/r", "repos":[]}';
    expect(maskForwardedAnswer("changes", changes)).toBe(changes);
    const noHistory = '{"available":false, "reason":"unsupported"}';
    expect(maskForwardedAnswer("conversations", noHistory)).toBe(noHistory);
  });
});

describe("a picture, a blob and every other route pass untouched and unread", () => {
  // A picture's bytes can hold anything, a key-shaped run included; they are not text and are never read.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode(key)]);
  for (const path of ["/api/pane/w1:p1/files/image?path=a.png", "/api/workspace/w1/files/image?path=a.png", `/api/blobs/${"ab".repeat(32)}`]) {
    test(path, async () => {
      const { transport, seen } = member(png, 200, "image/png");
      const res = await viaLead(path, transport);
      expect(seen.pulls).toBe(0); // handed on, not read on the lead
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    });
  }

  test("the lead's mask off: a text answer is the member's bytes, as before", async () => {
    const body = JSON.stringify(chat);
    const { transport, seen } = member(body);
    const res = await viaLead("/api/pane/w1:p1/chat", transport, { mask: undefined });
    expect(seen.pulls).toBe(0);
    expect(await res.text()).toBe(body);
  });

  test("a member's 304 has no body and stays a 304 with its tag, salted", async () => {
    const res = await viaLead("/api/pane/w1:p1/chat", member(null, 304).transport);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(SALTED);
  });

  test("a member's error answer is its own: no session text, so not read", async () => {
    const { transport, seen } = member('{"error":"unknown-path"}', 404);
    const res = await viaLead("/api/pane/w1:p1/files?path=nope", transport);
    expect(res.status).toBe(404);
    expect(seen.pulls).toBe(0);
    expect(await res.text()).toBe('{"error":"unknown-path"}');
  });
});

describe("fail closed: a body that should be masked and cannot be is never passed on", () => {
  const broken: [string, string, string][] = [
    ["not JSON", "/api/pane/w1:p1/chat", `KEY=${key}`],
    ["JSON but not an object", "/api/pane/w1:p1", JSON.stringify([key])],
    ["a mirror without its text", "/api/pane/w1:p1", JSON.stringify({ paneId: "w1:p1", lines: [key] })],
    ["a History page whose entries are not a list", "/api/pane/w1:p1/history", JSON.stringify({ available: true, entries: { a: key } })],
    ["a turn without its parts", "/api/pane/w1:p1/history", JSON.stringify({ available: true, entries: [{ uuid: "u", text: key }] })],
    ["an image whose url is not a string", "/api/pane/w1:p1/history", JSON.stringify({ available: true, entries: [{ parts: [{ kind: "image", url: { u: key } }] }] })],
    ["a Chat window without its queue", "/api/pane/w1:p1/chat", JSON.stringify({ ...chat, queued: undefined })],
    ["a History answer with no availability", "/api/pane/w1:p1/history", JSON.stringify({ entries: [entry] })],
    ["a diff that is not a string", "/api/pane/w1:p1/changes", JSON.stringify({ ...diff, diff: [key] })],
    ["a file text that is not a string", "/api/pane/w1:p1/files", JSON.stringify({ ...fileText, text: { t: key } })],
    ["a Clear's draft that is not a string", "/api/pane/w1:p1/clear", JSON.stringify({ requestId: "clear-req-0001", outcome: "cleared", draft: [key] })],
    ["a conversation title that is not a string", "/api/durable/conversations", JSON.stringify({ available: true, items: [{ id: "c", title: { t: key } }] })],
    ["a conversation subtitle that is not a string", "/api/durable/conversations", JSON.stringify({ available: true, items: [{ id: "c", title: "t", subtitle: { s: key } }] })],
    ["a conversation list whose items are not a list", "/api/durable/conversations", JSON.stringify({ available: true, items: { a: key } })],
    ["a conversation list with no availability", "/api/durable/conversations", JSON.stringify({ items: conversations.items })],
  ];
  for (const [name, path, body] of broken) {
    test(name, async () => {
      const res = await viaLead(path, member(body).transport);
      expect(res.status).toBe(502);
      const out = await res.text();
      expect(out).not.toContain(key);
      // SAFETY: a lead refusal is `forwardError`'s envelope; `code` and `host` are asserted.
      const refusal = JSON.parse(out) as { code: string; host: string };
      expect(refusal.code).toBe("answer_unmaskable");
      expect(refusal.host).toBe("laptop");
    });
  }
});

// A Clear's receipt (ADR 0116) carries the box's text for Restore, which types it back. A masked
// draft would type the mask, so where the mask is on a draft that holds a secret goes, whole.
describe("a Clear's receipt through the lead: a draft that holds a secret goes", () => {
  const tap = '{"requestId":"clear-req-0001"}';
  const cleared = (draft?: string): string =>
    JSON.stringify(draft === undefined ? { requestId: "clear-req-0001", outcome: "cleared" } : { requestId: "clear-req-0001", outcome: "cleared", draft });

  test("a member that does not mask: the phone gets the receipt without its draft, as from the lead's own pane", async () => {
    const res = await viaLead("/api/pane/w1:p1/clear", member(cleared(`export OPENAI_API_KEY=${key}`)).transport, { mask: maskForwardedAnswer, body: tap });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(cleared());
  });

  test("a draft with nothing to mask rides on; a receipt with no draft and a refusal are the member's own bytes", async () => {
    // Spacing a re-serialisation would drop: proof the bytes were handed back, not rebuilt.
    const refused = '{"requestId":"clear-req-0001", "outcome":"refused", "reason":"no_draft"}';
    for (const body of [cleared("half a thought"), cleared(), refused]) {
      const res = await viaLead("/api/pane/w1:p1/clear", member(body).transport, { mask: maskForwardedAnswer, body: tap });
      expect(await res.text()).toBe(body);
    }
  });

  test("the lead's mask off: the member's receipt is its own bytes, draft and all", async () => {
    const body = cleared(`export OPENAI_API_KEY=${key}`);
    const { transport, seen } = member(body);
    const res = await viaLead("/api/pane/w1:p1/clear", transport, { mask: undefined, body: tap });
    expect(seen.pulls).toBe(0);
    expect(await res.text()).toBe(body);
  });
});

// A reply runs the Send Protocol (M56 spec 06), and its answer carries the Surface it read, the ask
// labels on the screen included. A member masks them by its own switch, and the lead by its own.
describe("a reply through the lead: the Surface's ask labels are masked", () => {
  const tap = '{"text":"hi","submit":true,"id":"phone-req-0001"}';
  const post = (body: string) => viaLead("/api/pane/w1:p1/reply", member(body).transport, { mask: maskForwardedAnswer, body: tap });

  test("a member that does not mask: the phone gets the labels masked and every other field as the member sent it", async () => {
    const res = await post(JSON.stringify(reply));
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out).not.toContain(key);
    const options = [{ id: "1", label: "Yes" }, { id: "2", label: `Yes, and use ${masked}` }];
    expect(JSON.parse(out)).toEqual({ ...reply, send: { ...reply.send, surface: { ...surface, modal: { ask: { ...ask, options } } } } });
  });

  test("a keys reply, a refusal before the protocol ran, and an answer that read no screen are the member's own bytes", async () => {
    // Spacing a re-serialisation would drop: proof the bytes were handed back, not rebuilt.
    const keys = '{"ok":true}';
    const old = '{"ok":false, "textDelivered":false, "code":"reply.send_failed"}';
    const noScreen = '{"ok":true, "send":{"receipt":{"requestId":"phone-req-0001","outcome":"sent"}, "offers":[]}}';
    for (const body of [keys, old, noScreen]) expect(await (await post(body)).text()).toBe(body);
  });

  test("a Surface with no dialog on it carries no labels, and goes on as the member sent it", async () => {
    for (const modal of ["none", "unreadable", "unknown"] as const) {
      const body = { ...reply, send: { ...reply.send, surface: { ...surface, modal } } };
      const res = await post(JSON.stringify(body));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(body);
    }
  });

  test("a protocol answer that is not an object, or a Surface the mask cannot walk, is refused, never passed on", async () => {
    const odd = { ...surface, modal: { ask: { ...ask, options: [{ id: "2", label: { t: key } }] } } };
    for (const body of [{ ...reply, send: [key] }, { ...reply, send: { ...reply.send, surface: odd } }, { ...reply, send: { ...reply.send, surface: null } }]) {
      const res = await post(JSON.stringify(body));
      expect(res.status).toBe(502);
      const out = await res.text();
      expect(out).not.toContain(key);
      expect(out).toContain("answer_unmaskable");
    }
  });

  test("the lead's mask off: the member's answer is its own bytes, labels and all", async () => {
    const body = JSON.stringify(reply);
    const { transport, seen } = member(body);
    const res = await viaLead("/api/pane/w1:p1/reply", transport, { mask: undefined, body: tap });
    expect(seen.pulls).toBe(0);
    expect(await res.text()).toBe(body);
  });
});

describe("a durable program's conversation list through the lead", () => {
  test("a member that does not mask: the phone gets the list its own route would have masked", async () => {
    const adapter = { listConversations: async () => muxOk<MuxConversationPage>({ items: [{ id: "conv-1", title: `Ticket ${key}`, subtitle: `about ${key}`, startedAt: "2026-10-13T09:00:00.000Z", state: "open", items: 2 }] }) };
    const url = new URL("http://member/api/durable/conversations");
    const answer = async (redact: boolean) => (await durableConversations(adapter, url, new Request(url), redact)).text();
    const clear = await answer(false);
    expect(clear).toContain(key);
    const res = await viaLead("/api/durable/conversations", member(clear).transport);
    const out = await res.text();
    expect(out).not.toContain(key);
    expect(out).toBe(await answer(true));
  });
});

describe("the merged snapshot's titles", () => {
  test("a member's program-set title is masked; a label and a masked title are left as they are", () => {
    const snap = {
      agents: [
        { paneId: "w1:p1", terminalTitle: `vim ${key}` },
        { paneId: "w1:p2", terminalTitle: masked },
        { paneId: "w1:p3", label: `mine ${key}` },
      ],
      shellPanes: [{ paneId: "w1:p4", terminalTitle: `curl ${key}` }],
    };
    const out = maskSnapshotPanes(snap);
    expect(out.agents[0]!.terminalTitle).toBe(`vim ${masked}`);
    expect(out.agents[1]!.terminalTitle).toBe(masked);
    expect(out.agents[2]).toEqual(snap.agents[2]!);
    expect(out.shellPanes[0]!.terminalTitle).toBe(`curl ${masked}`);
  });
});

// A member's own snapshot masks its panes' screen text by its own switch: the Surface's ask labels,
// a hook-held permission's input and labels, and the held sends. The lead masks them by its own.
describe("the merged snapshot's screen text", () => {
  const hold: HoldNote = { askId: "hold-1", state: "held", tool: "Bash", input: `curl ${key}`, agent: false, options: ["Yes", `use ${key}`, "No"], hash: "0abc12", adopted: true, since: 1 };
  const heldRow: HeldRow = { requestId: "phone-req-0002", mode: "send", text: `use ${key}`, heldAt: 1, expiresAt: 2, state: "held" };
  const pane = (over: Partial<PaneWire> & { paneId: string }): PaneWire => ({
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "blocked",
    cwd: "/home/you",
    focused: false,
    kind: "agent",
    ...over,
  });
  /** The lead's `/api/snapshot` with its mask on: its own panes merged with the member's body as it came off the wire, then masked. */
  const merged = (memberBody: PeerSnapshotWire, own: PaneWire[] = []): SnapshotResponse => {
    const local: SnapshotResponse = { bridge: "connected", agents: own, shellPanes: [], workspaces: [], tabs: [], sessions: [], notifications: { snoozedUntil: null }, ts: 1 };
    const body = parsePeerSnapshot(JSON.parse(JSON.stringify(memberBody)));
    return maskSnapshotPanes(mergeSnapshot(local, { self: { id: "desk", name: "desk" }, peers: [{ state: REACHABLE, name: "laptop", body }], now: 1 }));
  };

  test("a member that does not mask: its labels, its hold and its held sends reach the phone masked; ids and hashes stay", () => {
    const shell = pane({ paneId: "w1:p9", agent: "shell", kind: "shell", status: "idle", held: [heldRow] });
    const out = merged({ sessions: [], agents: [pane({ paneId: "w1:p1", surface, hold, held: [heldRow] })], shellPanes: [shell] });
    expect(JSON.stringify(out)).not.toContain(key);
    const agent = out.agents[0]!;
    expect(agent.surface).toEqual({ ...surface, modal: { ask: { ...ask, options: [{ id: "1", label: "Yes" }, { id: "2", label: `Yes, and use ${masked}` }] } } });
    expect(agent.hold).toEqual({ ...hold, input: `curl ${masked}`, options: ["Yes", `use ${masked}`, "No"] });
    expect(agent.held).toEqual([{ ...heldRow, text: `use ${masked}` }]);
    expect(out.shellPanes[0]!.held).toEqual([{ ...heldRow, text: `use ${masked}` }]);
  });

  test("the lead's own panes, already masked, are left as they are", () => {
    const own = maskSnapshotPanes({ agents: [pane({ paneId: "w1:p1", surface, hold, held: [heldRow] })], shellPanes: [] }).agents;
    const out = merged({ sessions: [], agents: [], shellPanes: [] }, own);
    expect(out.agents).toEqual(own.map((p) => Object.assign({}, p, { host: "desk" })));
  });

  test("a Surface with no dialog on it, and a pane with no screen fields, are left as they are", () => {
    const quiet = [pane({ paneId: "w1:p1", surface: { ...surface, modal: "none" } }), pane({ paneId: "w1:p2" })];
    const out = merged({ sessions: [], agents: quiet, shellPanes: [] });
    expect(out.agents).toEqual(quiet.map((p) => Object.assign({}, p, { host: "laptop" })));
  });

  test("a screen field the mask cannot walk is dropped, never passed on in clear and never thrown on", () => {
    const unwalkable = [
      pane({ paneId: "w1:p2" }),
      { ...pane({ paneId: "w1:p3" }), surface: { ...surface, modal: { ask: { ...ask, options: [{ id: "2", label: { t: key } }] } } }, hold: { ...hold, input: { t: key } }, held: [{ ...heldRow, text: { t: key } }] },
      { ...pane({ paneId: "w1:p4" }), surface: { ...surface, modal: "a word this build does not know" }, hold: { ...hold, options: `use ${key}` }, held: { text: key } },
      { ...pane({ paneId: "w1:p5", surface, held: [heldRow] }), hold: { ...hold, options: ["Yes", { t: key }] } },
      pane({ paneId: "w1:p6", surface, hold, held: [heldRow] }),
      { ...pane({ paneId: "w1:p7" }), surface: { ...surface, modal: { ask: { ...ask, options: [null] } } }, held: [null] },
      { ...pane({ paneId: "w1:p8" }), surface: [key] },
    ];
    const out = merged({ sessions: [], agents: unwalkable, shellPanes: [] });
    expect(JSON.stringify(out)).not.toContain(key);
    for (const id of ["w1:p3", "w1:p4", "w1:p7", "w1:p8"]) {
      const dropped = out.agents.find((p) => p.paneId === id)!;
      expect(dropped).not.toHaveProperty("surface");
      expect(dropped).not.toHaveProperty("hold");
      expect(dropped).not.toHaveProperty("held");
    }
    // Only the field the mask cannot walk goes: the same pane's Surface and held sends stay, masked.
    const oddHold = out.agents.find((p) => p.paneId === "w1:p5")!;
    expect(oddHold).not.toHaveProperty("hold");
    expect(oddHold.held?.[0]?.text).toBe(`use ${masked}`);
    const kept = out.agents.find((p) => p.paneId === "w1:p6")!;
    expect(kept.surface?.modal).toEqual({ ask: { ...ask, options: [{ id: "1", label: "Yes" }, { id: "2", label: `Yes, and use ${masked}` }] } });
    expect(kept.hold?.input).toBe(`curl ${masked}`);
    expect(kept.held?.[0]?.text).toBe(`use ${masked}`);
  });
});

describe("a pane's todo list", () => {
  test("maskTodoList masks the words and leaves the id and the status", () => {
    const todos = [
      { id: "1", text: `export KEY=${key}`, status: "in_progress" as const, activeForm: `Exporting ${key}` },
      { id: "2", text: "Run the tests", status: "pending" as const },
    ];
    const out = maskTodoList(todos);
    expect(out[0]).toEqual({ id: "1", text: `export KEY=${masked}`, status: "in_progress", activeForm: `Exporting ${masked}` });
    expect(out[1]).toEqual(todos[1]!);
    expect(todos[0]!.text).toContain(key);
  });

  test("the merged snapshot masks a member's todo text as it masks a title", () => {
    const snap = {
      agents: [{ paneId: "w1:p1", todos: [{ id: "1", text: `use ${key}`, status: "pending" as const }] }, { paneId: "w1:p2" }],
      shellPanes: [],
    };
    const out = maskSnapshotPanes(snap);
    expect(out.agents[0]!.todos![0]!.text).toBe(`use ${masked}`);
    expect(out.agents[1]).toEqual({ paneId: "w1:p2" });
  });
});

describe("a masked answer's tag names the mask's version", () => {
  test("the phone's salted tag reaches the member as the member's own", async () => {
    const { transport, seen } = member(null, 304);
    const res = await viaLead("/api/pane/w1:p1/chat", transport, {
      mask: maskForwardedAnswer,
      headers: { "if-none-match": SALTED },
    });
    expect(seen.headers.get("if-none-match")).toBe(ETAG);
    expect(res.status).toBe(304);
  });

  test("a tag without the salt is dropped, so a copy a lead passed on unmasked is fetched again", async () => {
    // A 1.17 lead passed the member's tag on bare, over a body it never masked. That tag must not buy
    // a 304 for the copy: the member answers in full, and this lead masks it.
    const body = JSON.stringify({ paneId: "w1:p1", text: key });
    const { transport, seen } = member(body);
    const res = await viaLead("/api/pane/w1:p1", transport, {
      mask: maskForwardedAnswer,
      headers: { "if-none-match": ETAG },
    });
    expect(seen.headers.get("if-none-match")).toBeNull();
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(key);
  });

  test("a tag salted under another version is dropped too", () => {
    expect(unsaltIfNoneMatch('"abc~m0"')).toBeNull();
    expect(unsaltIfNoneMatch(`"abc~m0", ${saltTag('"def"')}`)).toBe('"def"');
    expect(unsaltIfNoneMatch(saltTag('W/"abc"'))).toBe('W/"abc"');
  });

  test("a value that is not a quoted tag is left as it is", () => {
    expect(saltTag("*")).toBe("*");
    expect(saltTag("")).toBe("");
  });

  test("the lead's mask off: the phone's tag reaches the member as it was sent", async () => {
    const { transport, seen } = member(null, 304);
    const res = await viaLead("/api/pane/w1:p1/chat", transport, { mask: undefined, headers: { "if-none-match": ETAG } });
    expect(seen.headers.get("if-none-match")).toBe(ETAG);
    expect(res.headers.get("etag")).toBe(ETAG);
  });

  test("a picture's tag is never salted: the lead does not read it", async () => {
    const { transport, seen } = member(new Uint8Array([1, 2, 3]), 200, "image/png");
    const res = await viaLead("/api/pane/w1:p1/files/image?path=a.png", transport, {
      mask: maskForwardedAnswer,
      headers: { "if-none-match": ETAG },
    });
    expect(seen.headers.get("if-none-match")).toBe(ETAG);
    expect(res.headers.get("etag")).toBe(ETAG);
  });
});
