// withCollie's opener (M66 spec 03): each session gets a registry of its own that follows the program's and ends with
// the guard, and an opener that does not open the Harness with it fails closed. The guard itself is tested through the
// route in route.test.ts (askThroughJournal) and on a real Harness in real-harness.test.ts.
import { describe, expect, test } from "bun:test";
import { createRegistry, defineExtension, type Harness, type Registry } from "@earendil-works/pi-durable";
import { api } from "../../durable-member/tests/client.ts";
import type { JournalAsk, JournalRecord } from "../../../packages/durable-sdk/src/core/journal.ts";
import { paneIdOfRun } from "../../../packages/durable-sdk/src/durable-harness/pi-source.ts";
import type { JournalPort } from "../../../packages/durable-sdk/src/durable-harness/route.ts";
import { askThroughJournal, GUARD, withCollie } from "../../../packages/durable-sdk/src/durable-harness/with-collie.ts";
import type { WorldStorage } from "../../../packages/durable-sdk/src/durable-harness/world-port.ts";
import { assistantEntry, FakeWorld, userEntry } from "./fake-world.ts";
import { FakeSession, rig, until } from "./rig.ts";

const world = new FakeWorld();
// SAFETY: the opener reads `sessionId`, `isFenced` and `signal`; the journal comes from the `journal` option, not `world`.
const storage = (id: string) => new FakeSession(id) as unknown as WorldStorage;
let closed = 0;
// SAFETY: withCollie calls `close` on a Harness it refuses, and nothing else.
const harness = { close: async () => void closed++ } as unknown as Harness;
const names = (r: Registry) => r.snapshot().installed().map((e) => e.name);

describe("withCollie", () => {
  test("a session's registry is the program's extensions, then the guard, and follows the program's registry", async () => {
    const base = createRegistry();
    base.install(defineExtension({ name: "tools" }));
    let seen: Registry | undefined;
    const open = withCollie(async (_s, registry) => ((seen = registry), names(registry), harness), { registry: base, risky: new Set(["refund"]), journal: () => world.port() });
    await open(storage("wrun_01A"));
    expect(names(seen!)).toEqual(["tools", GUARD]);
    base.install(defineExtension({ name: "more" }));
    expect(names(seen!)).toEqual(["tools", "more", GUARD]);
    base.uninstall({ name: "tools" } as never);
    expect(names(seen!)).toEqual(["more", GUARD]);
  });

  test("an opener that never reads the registry it was given fails closed: no Harness without the guard", async () => {
    const before = closed;
    const open = withCollie(async () => harness, { registry: createRegistry(), risky: new Set(["refund"]), journal: () => world.port() });
    expect(open(storage("wrun_01B"))).rejects.toThrow(/did not open the Harness with the registry withCollie gave it/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(before + 1);
  });
});

describe("the guard's poll", () => {
  const FAST = { pollMs: { first: 5, max: 20 } };
  const idle = { eventCount: 4, entries: [userEntry(1, "refund 5521"), assistantEntry(3, "On it.")] };
  const reads = (w: FakeWorld) => w.calls.filter((c) => c === "streams.getChunks").length;
  const guardOn = (w: FakeWorld, run: string, session: FakeSession, errors: number[] = []) =>
    askThroughJournal({ id: "call-1", name: "refund", arguments: { order: "5521" } }, session, w.port(), { ...FAST, onReadError: (_e, n) => errors.push(n) });

  test("a read that fails twice inside the wait is retried: the answer that follows still allows", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idle });
    const errors: number[] = [];
    const decided = guardOn(r.world, run, new FakeSession(run), errors);
    await until("the ask in the journal", () => (r.world.chunks.size > 0 ? true : undefined));
    const ask = await until("the ask on the phone", async () => (await api.snapshot(r.dial())).body.panes.find((p) => p.id === paneIdOfRun(run))?.openAsks[0]);
    r.world.down = true; // the World is unreachable for the guard's next reads
    await until("two failed reads", () => (errors.length >= 2 ? true : undefined));
    r.world.down = false;
    expect((await api.answer(r.dial(), paneIdOfRun(run), ask.id, "allow")).body).toEqual({ result: "taken" });
    expect(await decided).toBeUndefined();
    expect(errors.slice(0, 2)).toEqual([1, 2]);
  });

  test("a read that fails for ever is never a verdict: it ends only with the session, as the lost-session block", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idle });
    const session = new FakeSession(run);
    const errors: number[] = [];
    const decided = guardOn(r.world, run, session, errors);
    await until("the ask in the journal", () => (r.world.chunks.size > 0 ? true : undefined));
    r.world.down = true;
    await until("five failed reads", () => (errors.length >= 5 ? true : undefined));
    const before = reads(r.world);
    session.fence();
    expect(await decided).toEqual({ block: "this process lost the session" });
    expect(reads(r.world)).toBe(before);
  });

  test("an expiry the World refused when the clock fired is written again after each read until one lands: the call blocks as timed out", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idle });
    const session = new FakeSession(run);
    let timedOut = 0;
    const decided = askThroughJournal({ id: "call-1", name: "refund", arguments: { order: "5521" } }, session, r.world.port(), { ...FAST, timeoutMs: 200, onTimeout: () => void timedOut++ });
    let done = false;
    void decided.then(() => (done = true));
    try {
      await until("the ask in the journal", () => (r.world.chunks.size > 0 ? true : undefined));
      const from = r.world.calls.length;
      const refused = () => r.world.calls.slice(from).filter((c) => c === "streams.write").length;
      r.world.down = true; // the World is unreachable when the ask's timer fires
      await until("the timer's write, refused", () => refused() >= 1, 1000);
      // Reads come back while writes stay refused: the guard writes the expiry again after each read that finds the ask open.
      r.world.down = false;
      r.world.writesDown = true;
      const readsBefore = reads(r.world);
      await until("two more refused writes of the expiry", () => refused() >= 3, 1000);
      expect(reads(r.world) - readsBefore).toBeGreaterThanOrEqual(2);
      expect((await r.world.port().readJournal(run)).map((x) => x.t)).toEqual(["ask"]);
      // The phone reads the ask as closed by the clock at its expiry, from the `ask` record alone.
      expect((await api.snapshot(r.dial())).body.panes.find((p) => p.id === paneIdOfRun(run))?.openAsks).toEqual([]);
      expect(done).toBe(false);
      r.world.writesDown = false;
      await until("the guard's verdict", () => done, 1000);
    } finally {
      session.fence();
    }
    expect(await decided).toEqual({ block: "timed out" });
    expect(timedOut).toBe(1);
    const records = await r.world.port().readJournal(run);
    const ask = records.find((x): x is JournalAsk => x.t === "ask")!;
    expect(records.filter((x) => x.t === "expire")).toEqual([{ t: "expire", askId: ask.askId, at: ask.expiresAt!, decidedBy: "timeout" }]);
  });

  test("at most one write of the timeout is in flight: reads while a retried write is held start no other", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idle });
    const session = new FakeSession(run);
    const base = r.world.port();
    // A port whose expiry writes wait until the test settles them; every other call goes to the World.
    const held: { settle: (refuse: boolean) => void }[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    const port: JournalPort = {
      readJournal: (id) => base.readJournal(id),
      appendJournal: (id, record: JournalRecord) => {
        if (record.t !== "expire") return base.appendJournal(id, record);
        mostInFlight = Math.max(mostInFlight, ++inFlight);
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        held.push({
          settle: (refuse) => {
            inFlight--;
            if (refuse) reject(new Error("fake World: write refused"));
            else base.appendJournal(id, record).then(resolve, reject);
          },
        });
        return promise;
      },
    };
    const decided = askThroughJournal({ id: "call-1", name: "refund", arguments: { order: "5521" } }, session, port, { ...FAST, timeoutMs: 100 });
    try {
      await until("the timer's write", () => held.length >= 1, 1000);
      held[0]!.settle(true);
      await until("the retried write, after a read", () => held.length >= 2, 1000);
      const readsBefore = reads(r.world);
      await until("three more reads while the retried write is held", () => reads(r.world) - readsBefore >= 3, 1000);
      expect(held.length).toBe(2);
      expect(mostInFlight).toBe(1);
      held[1]!.settle(false);
      expect(await decided).toEqual({ block: "timed out" });
    } finally {
      session.fence();
    }
    expect(held.length).toBe(2);
    expect((await base.readJournal(run)).filter((x) => x.t === "expire")).toHaveLength(1);
  });

  test("the first read, before the wait, still throws when the World is down: nothing is written", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idle });
    r.world.down = true;
    expect(guardOn(r.world, run, new FakeSession(run))).rejects.toThrow(/unreachable/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.world.chunks.size).toBe(0);
  });
});
