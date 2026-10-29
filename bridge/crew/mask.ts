import {
  maskChatBody,
  maskClearReceipt,
  maskConversationRows,
  maskDiff,
  maskFileBody,
  maskHistoryPage,
  maskPaneRead,
  maskSendAnswer,
  maskSentAnswer,
} from "../answer-mask.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import type { ChatBody } from "../journal/live.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import type { ChangeDiff, FileReadAnswer, PaneReadResponse } from "../types.ts";
import type { AnswerMask, TextAnswer } from "./forward.ts";

// The LEAD's mask over a member's text answer (CREW_PROTOCOL.md §9.1). The member's body is parsed,
// checked for the shape its route answers with, and masked by the very function the lead's own route
// uses for the same answer (`bridge/answer-mask.ts`). Nothing here masks by a rule of its own.
//
// ── FAIL CLOSED, BY SHAPE ────────────────────────────────────────────────────
// `null` means "do not pass this on": the body is not JSON, or it is not the answer the route makes.
// The check is exactly as deep as the mask needs, no deeper: every field the mask walks must be the
// type it walks, because a field of another type would be passed over rather than masked. Turns are
// walked whole by `redactEntry` (every string in a part but a label the bridge wrote), so a turn needs
// only its `parts` list and an image part its `url` string. A field the mask does not touch on the
// lead's own route (a cursor, a count, a root, a commit list) is not checked and not touched here
// either, so a member one release ahead with a new field still answers.
//
// ── NO CHANGE, NO NEW BYTES ──────────────────────────────────────────────────
// An answer with nothing to mask (`available: false`, a listing, a commit list) goes back as the
// member's own bytes, unparsed past the shape check. A masked answer is re-serialised with
// `JSON.stringify`, the member's own serialiser, so a body a 1.18 member already masked comes back
// byte for byte: parse then stringify is a fixed point on stringify's output, and the mask is a fixed
// point on its own output.

/** A member's text answer, masked, or `null` when it cannot be read as that answer. */
export const maskForwardedAnswer: AnswerMask = (answer: TextAnswer, raw: string): string | null => {
  let body: JsonValue;
  try {
    // SAFETY: `JSON.parse` returns a JSON value by definition; `JsonValue` is the name for that type.
    body = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  if (!isObject(body)) return null;
  try {
    return maskBody(answer, body, raw);
  } catch {
    // The checks above the mask cover every field it reads; a throw past them is a shape nobody
    // planned for, and it is refused like any other.
    return null;
  }
};

function maskBody(answer: TextAnswer, body: JsonObject, raw: string): string | null {
  switch (answer) {
    case "pane":
      return isPaneRead(body) ? JSON.stringify(maskPaneRead(body)) : null;
    case "history":
      if (body.available === false) return raw;
      return body.available === true && isHistoryPage(body)
        ? JSON.stringify(maskHistoryPage(body))
        : null;
    case "chat":
      if (body.available === false) return raw;
      return body.available === true && isChatBody(body) ? JSON.stringify(maskChatBody(body)) : null;
    case "changes":
      // A list and a commit carry no diff, and the lead's own route masks neither.
      if (!("diff" in body)) return raw;
      return isDiff(body) ? JSON.stringify(maskDiff(body, true)) : null;
    case "files":
      // A listing is names only; the lead's own route masks a file's text alone.
      if (!("text" in body)) return raw;
      return isFileText(body) ? JSON.stringify(maskFileBody(body, true)) : null;
    case "sent":
      return isSentAnswer(body) ? JSON.stringify(maskSentAnswer(body)) : null;
    case "conversations":
      if (body.available === false) return raw;
      return body.available === true && isConversationList(body)
        ? JSON.stringify({ ...body, items: maskConversationRows(body.items) })
        : null;
    case "reply": {
      // A keys reply, and a refusal before the Send Protocol ran, carry no protocol answer; an answer
      // that read no screen carries no Surface. Neither has screen text to mask.
      if (!("send" in body)) return raw;
      const send = body.send;
      if (!isObject(send)) return null;
      if (!("surface" in send)) return raw;
      return isSendWithSurface(send) ? JSON.stringify({ ...body, send: maskSendAnswer(send) }) : null;
    }
    case "clear":
      // A refusal, and a receipt for a box that held no text, carry nothing to mask.
      if (!("draft" in body)) return raw;
      return isClearReceipt(body) ? JSON.stringify(maskClearReceipt(body)) : null;
  }
}

/** A Sent answer (ADR 0107) as deep as its mask reads it: an `entries` list whose every `line` is a string. */
function isSentAnswer(body: JsonObject): body is JsonObject & { entries: { line: string }[] } {
  return Array.isArray(body.entries) && body.entries.every((entry) => isObject(entry) && typeof entry.line === "string");
}

/** A durable program's conversation list (M53 spec 11) as deep as its mask reads it: every title a string, and every subtitle a row has. */
function isConversationList(body: JsonObject): body is JsonObject & { items: { title: string; subtitle?: string }[] } {
  return (
    Array.isArray(body.items) &&
    body.items.every((row) => isObject(row) && typeof row.title === "string" && (row.subtitle === undefined || typeof row.subtitle === "string"))
  );
}

/** A reply's Send Protocol answer (M56 spec 06) as deep as its mask reads it: a Surface the mask can walk. */
function isSendWithSurface(send: JsonObject): send is JsonObject & { surface: Surface } {
  return isWalkableSurface(send.surface);
}

// ── A MEMBER PANE'S SCREEN TEXT ──────────────────────────────────────────────
// What `maskSurface`, `maskHoldNote` and `maskHeldRows` walk, checked as deep as they walk it. A reply's
// Surface is checked here, and so is each pane's `surface`, `hold` and `held` when the lead parses a
// member's snapshot (`bridge/crew/merge.ts`), so a member one release ahead that changed one of their
// shapes never has it passed over in clear, nor thrown on.

/** A Surface (M56 spec 04): a modal word, or an ask whose every option label is a string. */
export function isWalkableSurface(value: JsonValue | undefined): value is JsonObject & Surface {
  if (!isObject(value)) return false;
  const modal = value.modal;
  if (modal === "none" || modal === "unreadable" || modal === "unknown") return true;
  const ask = isObject(modal) ? modal.ask : undefined;
  return isObject(ask) && Array.isArray(ask.options) && ask.options.every((option) => isObject(option) && typeof option.label === "string");
}

/** A hook-held permission's note (M56 spec 12): an input string and a list of label strings. */
export function isWalkableHold(value: JsonValue | undefined): boolean {
  return isObject(value) && typeof value.input === "string" && Array.isArray(value.options) && value.options.every((label) => typeof label === "string");
}

/** A pane's held sends (M56 spec 15): a list of rows whose every text is a string. */
export function isWalkableHeld(value: JsonValue | undefined): boolean {
  return Array.isArray(value) && value.every((row) => isObject(row) && typeof row.text === "string");
}

/** A Clear's receipt (ADR 0116) as deep as its mask reads it: a `draft` string. */
function isClearReceipt(body: JsonObject): body is JsonObject & { draft: string } {
  return typeof body.draft === "string";
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function isPaneRead(body: JsonObject): body is JsonObject & PaneReadResponse {
  return typeof body.text === "string" && (body.logicalText === undefined || typeof body.logicalText === "string");
}

/** A turn as `redactEntry` walks it: a `parts` list of objects, an image part with its `url` a string. */
function isEntry(value: JsonValue | undefined): value is JsonObject & TranscriptEntry {
  if (!isObject(value) || !Array.isArray(value.parts)) return false;
  return value.parts.every((part) => isObject(part) && (part.kind !== "image" || typeof part.url === "string"));
}

function isEntryList(value: JsonValue | undefined): value is (JsonObject & TranscriptEntry)[] {
  return Array.isArray(value) && value.every(isEntry);
}

function isHistoryPage(body: JsonObject): body is JsonObject & { entries: TranscriptEntry[] } {
  return isEntryList(body.entries);
}

function isChatBody(body: JsonObject): body is JsonObject & ChatBody {
  if (!isEntryList(body.upserts)) return false;
  // An older page carries no queue; a live window always does, as a list of strings.
  if (body.page === "older") return true;
  return body.page === "live" && Array.isArray(body.queued) && body.queued.every((q) => typeof q === "string");
}

function isDiff(body: JsonObject): body is JsonObject & Extract<ChangeDiff, { available: true }> {
  return body.available === true && typeof body.diff === "string";
}

function isFileText(body: JsonObject): body is JsonObject & Extract<FileReadAnswer, { available: true }> {
  return body.available === true && typeof body.text === "string";
}
