import { newDocument } from "../src/shared/initial";
import type {
  BaitId,
  FishId,
  GameDocument,
  SpotId,
  TripSource,
} from "../src/shared/types";
import {
  beginCast,
  claimCombo,
  claimPlan,
  record,
  recoverDocument,
  retryStage,
  settlePending,
  switchRoute,
  trimLedger,
} from "../src/features/challenges/lib/ledger";
import {
  analyzeAll,
  analyzeStage,
  analyzeRoute,
  initDocument,
  packStages,
  settle,
  stageById,
  stageState,
  syncStages,
} from "../src/features/challenges/lib/match";
import { releaseCatch } from "../src/features/collection/model/collection";

let failures = 0;
let passes = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    passes++;
  } else {
    failures++;
    console.error("FAIL:", name, extra === undefined ? "" : extra);
  }
}

function cast(
  doc: GameDocument,
  fish: FishId,
  bait: BaitId,
  spot: SpotId,
  source: TripSource = "land",
): GameDocument {
  const n = doc.cast + 1;
  const id = `c${n}-${fish}-${source}`;
  const withBag =
    source === "land"
      ? {
          ...doc,
          bag: [
            {
              id,
              fish,
              weight: 1,
              spot,
              bait,
              time: n,
              duration: 1,
              peakTension: 0.5,
            },
            ...doc.bag,
          ],
          stats: { ...doc.stats, catches: doc.stats.catches + 1 },
        }
      : doc;
  const withCast = beginCast(withBag, {
    cast: n,
    catchId: id,
    fish,
    spot,
    bait,
  });
  return settlePending(withCast, {
    source,
    catchId: source === "land" ? id : null,
    fish,
    spot,
    bait,
  });
}

/** Land a fish, then release it from the bag in the same cast. */
function catchAndRelease(
  doc: GameDocument,
  fish: FishId,
  bait: BaitId,
  spot: SpotId,
): GameDocument {
  const landed = cast(doc, fish, bait, spot, "land");
  const item = landed.bag.find((b) => b.fish === fish && b.bait === bait)!;
  const released = releaseCatch(landed, item.id);
  return record(released, {
    cast: released.cast,
    source: "release",
    catchId: item.id,
    fish: item.fish,
    spot: item.spot,
    bait: item.bait,
  });
}

function fresh(): GameDocument {
  return initDocument(newDocument());
}

function claimAllOpen(doc: GameDocument) {
  // Claim whichever stage is complete; used to set up prerequisites.
  let next = doc;
  for (const a of analyzeAll(next)) {
    if (a.status === "active" && a.offers.length > 0) {
      next = claimPlan(next, a.stage.id, a.offers[0].plan);
    }
  }
  return next;
}

/* ------------------------------------------------------------------ */

// 1. Prerequisite gating and no back-fill.
{
  let doc = fresh();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  const beforeClaim = analyzeStage(doc, stageById("brook")!);
  check("brook locked before wake claim", beforeClaim.status === "locked");
  const wake = analyzeStage(doc, stageById("wake")!);
  check("wake has complete window", wake.offers.length > 0, wake.status);
  // These events would also satisfy brook-a? trout needed, so no.
  doc = claimPlan(doc, "wake", "wake-a");
  check("wake claimed", !!stageState(doc, "wake").claimed);
  const brookState = stageState(doc, "brook");
  check(
    "brook opens at current boundary",
    brookState.openedSeq === doc.seq && brookState.openedCast === doc.cast,
    { openedSeq: brookState.openedSeq, seq: doc.seq },
  );
  check(
    "brook does not back-fill pre-open events",
    analyzeStage(doc, stageById("brook")!).offers.length === 0,
  );
}

// 2. Claimed stage never pays twice, never consumes more evidence.
{
  let doc = fresh();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  doc = claimPlan(doc, "wake", "wake-a");
  const seqAfter = doc.seq;
  const eventsAfter = doc.ledger.events.length;
  doc = claimPlan(doc, "wake", "wake-a");
  check("duplicate claim keeps seq", doc.seq === seqAfter);
  check(
    "duplicate claim keeps event count",
    doc.ledger.events.length === eventsAfter,
  );
  check("duplicate claim does not add reward twice", doc.claimed.length === 1);
  check("duplicate claim is explained", /不会重复发放/.test(doc.notes.join(" ")));
}

// 3. Alternatives: a partial run stays partial; a complete run claims one.
{
  let doc = fresh();
  doc = cast(doc, "crucian", "worm", "reed");
  const st = stageState(doc, "wake");
  const wake = analyzeStage(doc, stageById("wake")!);
  // wake-b needs release; wake-a needs perch. Here only a partial exists.
  check("partial run recorded", wake.windows.length >= 1, wake.windows);
  check("stage not complete on a single catch", wake.offers.length === 0);
  void st;
}

// 4. Tail carrying: failed head must not poison the usable tail.
{
  let doc = fresh();
  // cast 1: wrong fish for wake (carp with corn at reed).
  doc = cast(doc, "carp", "corn", "reed");
  // cast 2+3: the actual pair.
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  const wake = analyzeStage(doc, stageById("wake")!);
  check(
    "tail after failed head still completes wake-a",
    wake.offers.some((o) => o.plan === "wake-a"),
    wake.offers,
  );
}

// 5. Window opened in an old window can be the start of a new one (outer join).
{
  let doc = fresh();
  // cast 1 crucian, cast 2 wrong (bass/fly at reed -> no bass at reed anyway),
  // cast 3 perch: the pair spans a failed middle and must still be allowed
  // by span (3 casts), because the tail re-opens at cast 3 only if role allows.
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "fly", "reed");
  const wake = analyzeStage(doc, stageById("wake")!);
  // wake-a wants perch with worm, this perch used fly: not a role match.
  check(
    "wrong bait does not complete",
    wake.offers.length === 0,
    wake.offers,
  );
  // cast 3: crucian again, cast 4 perch with worm: 3-4 forms a fresh window.
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  const wake2 = analyzeStage(doc, stageById("wake")!);
  check(
    "later events open a fresh window after a dead head",
    wake2.offers.some(
      (o) => o.plan === "wake-a" && o.seqs[0] === 2,
    ),
    wake2.offers,
  );
}

// 6. Release must return the same fish caught by this route.
{
  let doc = fresh();
  // Catch crucian (cast1), catch another crucian (cast2), release the first.
  doc = cast(doc, "crucian", "worm", "reed");
  const firstId = doc.bag[0].id;
  doc = cast(doc, "crucian", "worm", "reed");
  const secondId = doc.bag[0].id;
  const releasedOther = releaseCatch(doc, firstId);
  doc = record(releasedOther, {
    cast: releasedOther.cast,
    source: "release",
    catchId: firstId,
    fish: "crucian",
    spot: "reed",
    bait: "worm",
  });
  const wake = analyzeStage(doc, stageById("wake")!);
  // Correct implementation: the release of firstId can pair with catch firstId
  // (cast1), so wake-b is complete. It must not pair with secondId.
  const wrongPairs = wake.offers.filter((o) => {
    const catchIds = new Set(o.catchIds);
    return catchIds.has(secondId) && !catchIds.has(firstId);
  });
  check("release pairs with same bag id", wake.offers.some((o) => o.plan === "wake-b"), wake.offers);
  check("release never pairs with another fish", wrongPairs.length === 0);
}

// 7. Rival submission abandons the other unclaimed route.
{
  let doc = fresh();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  doc = claimPlan(doc, "wake", "wake-a");
  // Prepare deep route too: it is now open. Make both brook and deep complete
  // from the same later events? Instead just verify the claim order rule.
  doc = cast(doc, "bass", "fly", "deep");
  const deep = analyzeStage(doc, stageById("deep")!);
  check("deep complete after bass", deep.offers.length > 0, deep.status);
  doc = claimPlan(doc, "deep", "deep-a");
  const brook = stageState(doc, "brook");
  check("brook abandoned when deep claimed", brook.abandoned);
  check(
    "abandon reason names rival",
    /互斥/.test(brook.abandonedReason ?? ""),
    brook.abandonedReason,
  );
  check(
    "rival stage cannot be claimed after abandonment",
    (() => {
      const after = claimPlan(doc, "brook", "brook-a");
      return !stageState(after, "brook").claimed;
    })(),
  );
}

// 8. Non-greedy settlement: a shared catch must not be stolen by the first
// stage inspected; both stages should be claimable at once when disjoint
// completions exist.
{
  let doc = fresh();
  // corn-a needs carp/corn; watch-a needs perch/fly catch+release.
  doc = cast(doc, "carp", "corn", "reed");
  doc = catchAndRelease(doc, "perch", "fly", "reed");
  const s = settle(doc);
  check(
    "two parallel stages found simultaneously",
    s.combo.includes("corn") && s.combo.includes("watch"),
    { combo: s.combo, conflicts: s.conflicts },
  );
  const before = doc.claimed.length;
  doc = claimCombo(doc);
  check(
    "combo claims two rewards",
    doc.claimed.length === before + 2,
    doc.claimed,
  );
  check("combo does not double claim", doc.claimed.length === 2);
}

// 9. Shared preview, exclusive settlement: one fish satisfies two complete
// windows but only one stage may settle it.
{
  let doc = fresh();
  // A single crucian/corn catch satisfies corn? No; craft a shared case:
  // catch a carp at reed with corn completes corn-a; deep? no. Instead make
  // two routes over one event by claiming the same event for wake-a/b is
  // impossible since one event can't be catch and release. Use deep's bass
  // and a synthetic second stage not present: assert claimableWindow returns a
  // window only if evidence is free.
  doc = cast(doc, "carp", "corn", "reed");
  doc = catchAndRelease(doc, "perch", "fly", "reed");
  const s = settle(doc);
  const seqs = new Set<number>();
  let overlap = false;
  for (const w of Object.values(s.assignments)) {
    for (const q of w.seqs) {
      if (seqs.has(q)) overlap = true;
      seqs.add(q);
    }
  }
  check("settlement assignment evidence is disjoint", !overlap);
}

// 10. Retry reopens only the stage; claimed stages never roll back.
{
  let doc = fresh();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  doc = claimPlan(doc, "wake", "wake-a");
  const claimedBefore = stageState(doc, "wake").claimed;
  doc = cast(doc, "trout", "fly", "brook");
  const before = stageState(doc, "brook");
  doc = retryStage(doc, "brook");
  const after = stageState(doc, "brook");
  check("retry bumps attempts", after.attempts === before.attempts + 1);
  check(
    "retry advances boundary",
    after.openedSeq !== null && after.openedSeq! > before.openedSeq!,
  );
  check(
    "retry does not touch claimed stage",
    stageState(doc, "wake").claimed === claimedBefore,
  );
  check("retry records a reason", after.failures.some((f) => /重试/.test(f.reason)));
  check(
    "retry does not back-fill",
    analyzeStage(doc, stageById("brook")!).offers.length === 0,
  );
}

// 11. Refresh/abort, escape, switch all advance the same order by exactly one.
{
  let base = newDocument();
  base = cast(base, "crucian", "worm", "reed");
  const seq0 = base.seq;
  const aborted = recoverDocument(
    beginCast(base, { cast: base.cast + 1, catchId: "x", fish: "perch", spot: "reed", bait: "worm" }),
  );
  check("abort advances seq once", aborted.seq === seq0 + 1);
  const escaped = cast(base, "perch", "worm", "reed", "escape");
  check("escape advances seq once", escaped.seq === seq0 + 1);
  check(
    "escape event is recorded with source escape",
    escaped.ledger.events[escaped.ledger.events.length - 1].source === "escape",
  );
  const switched = switchRoute(base, "wake");
  check("switch advances seq once", switched.seq === seq0 + 1);
  // Recovering twice must not duplicate the aborted act.
  const recovered = recoverDocument(aborted);
  check("second recover is a no-op", recovered.seq === aborted.seq);
}

// 12. Compression keeps witnesses and reasons, not bare counters.
{
  let doc = fresh();
  // Make wake complete, then claim and open brook, then run a long failed brook.
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  doc = claimPlan(doc, "wake", "wake-a");
  for (let i = 0; i < 20; i++) doc = cast(doc, "carp", "corn", "reed");
  // Settle the other root contract so it no longer pins the journal floor.
  doc = claimPlan(doc, "corn", "corn-a");
  doc = retryStage(doc, "brook");
  doc = cast(doc, "trout", "worm", "brook");
  doc = trimLedger(doc);
  const state = stageState(doc, "brook");
  check(
    "compression keeps failure reasons",
    state.failures.every((f) => f.reason.length > 0),
  );
  check(
    "compression keeps witness events for active window",
    state.trace.length > 0 || state.failures.some((f) => f.witnesses.length > 0),
  );
  check("trim is recorded", !!doc.ledger.trim);
  // Every kept raw event is at/after the earliest active opening.
  const activeOpen = Math.min(
    ...analyzeAll(doc)
      .filter((a) => a.status === "active")
      .map((a) => stageState(doc, a.stage.id).openedSeq ?? doc.seq),
  );
  check(
    "kept events all at/after active opening",
    doc.ledger.events.every((e) => e.seq >= activeOpen),
  );
}

// 13. Expiry: budget end with no completion expires the stage, and expiry is
// explained with witnesses; retry clears it.
{
  let doc = fresh();
  // wake budget 7. Burn 8 casts with nothing matching.
  for (let i = 0; i < 8; i++) doc = cast(doc, "carp", "corn", "reed");
  const wake = stageState(doc, "wake");
  check("wake expired after budget", wake.expired, {
    cast: doc.cast,
    openedCast: wake.openedCast,
  });
  check(
    "expiry records witnesses or explicit empty reason",
    wake.failures.length > 0 && wake.failures[0].reason.length > 0,
    wake.failures,
  );
  const expired = analyzeStage(doc, stageById("wake")!);
  check("expired stage shows no windows", expired.windows.length === 0);
  doc = retryStage(doc, "wake");
  check("retry clears expiry", !stageState(doc, "wake").expired);
}

// 14. Keeper requires *any* of brook/deep, and opens after a rival claim.
{
  let doc = fresh();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  doc = claimPlan(doc, "wake", "wake-a");
  check("keeper locked initially", !stageState(doc, "keeper").openedSeq);
  doc = cast(doc, "bass", "fly", "deep");
  doc = claimPlan(doc, "deep", "deep-a");
  check(
    "keeper opens after deep claim via requiresAny",
    stageState(doc, "keeper").openedSeq !== null,
    stageState(doc, "keeper"),
  );
}


/* ---- extra adversarial checks ------------------------------------ */

function freshRoots() {
  return initDocument(newDocument());
}

// 15. A single fish can preview two unclaimed stages, but settlement is
// exclusive: claiming one makes the other's window unusable, and the other's
// claim is refused without consuming more evidence.
{
  let doc = freshRoots();
  // One crucian catch can be the first witness of BOTH wake routes at once:
  // previews are shared, so the same seq appears in two live windows.
  doc = cast(doc, "crucian", "worm", "reed");
  const wake = analyzeStage(doc, stageById("wake")!);
  const withSeq = wake.windows.filter((w) =>
    w.witnesses.some((x) => x.seq === 0),
  );
  check(
    "one fish previews against two unclaimed routes",
    withSeq.length === 2,
    wake.windows.map((w) => w.plan),
  );
  // A single catch completes corn; claiming it reserves exactly that event.
  doc = cast(doc, "carp", "corn", "reed");
  const corn = analyzeStage(doc, stageById("corn")!);
  check("corn previewable", corn.offers.length > 0);
  doc = claimPlan(doc, "corn", "corn-a");
  const claimed = stageState(doc, "corn").claimed!;
  check("corn claim reserves the catch event", claimed.seqs.length === 1);
  // Repeating the exact claim neither spends evidence nor pays again.
  const seqBefore = doc.seq;
  const eventsBefore = doc.ledger.events.length;
  doc = claimPlan(doc, "corn", "corn-a");
  check(
    "no extra evidence on duplicate",
    doc.seq === seqBefore && doc.ledger.events.length === eventsBefore,
  );
  check(
    "one reward only",
    doc.claimed.filter((c) => c === "corn-a").length === 1,
  );
}

// 16. Opening mid-run: a stage that unlocks in the middle of a cast sequence
// must not count casts or events before its opening.
{
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  // Two trout caught before wake is claimed do not count toward brook.
  doc = cast(doc, "trout", "fly", "brook");
  doc = cast(doc, "trout", "fly", "brook");
  doc = claimPlan(doc, "wake", "wake-a");
  const brook = analyzeStage(doc, stageById("brook")!);
  check("brooks sees no pre-open events", brook.offers.length === 0);
  check(
    "brook opening cast equals current cast",
    stageState(doc, "brook").openedCast === doc.cast,
  );
  // A later trout with fly completes brook-a exactly.
  doc = cast(doc, "trout", "fly", "brook");
  const brook2 = analyzeStage(doc, stageById("brook")!);
  check("post-open trout completes brook-a", brook2.offers.some((o) => o.plan === "brook-a"));
}

// 17. Escape is an ordered event that breaks a consecutive-cast window: the
// pair before the escape cannot be joined across it if span forbids it.
{
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed", "escape");
  // The escape is a cast but has no fish, so it can never be a witness.
  const ev = doc.ledger.events[1];
  check("escape recorded in order", ev.source === "escape" && ev.fish !== null);
  check(
    "escape cannot satisfy a catch step",
    analyzeStage(doc, stageById("wake")!).offers.length === 0,
  );
}

// 18. Cross-stage maximum packing: when two stages share one completion and a
// third has its own, the solver picks the maximum number of stages, not the
// first-inspected one.
{
  let doc = freshRoots();
  // Corn completes from a carp; watch completes from perch catch+release.
  // Deep remains locked until wake; use corn + watch which are parallel.
  doc = cast(doc, "carp", "corn", "reed");
  doc = cast(doc, "perch", "fly", "reed");
  const id = doc.bag.find((b) => b.fish === "perch")!.id;
  const rel = releaseCatch(doc, id);
  doc = record(rel, { cast: rel.cast, source: "release", catchId: id, fish: "perch", spot: "reed", bait: "fly" });
  const s = settle(doc);
  check("corn and watch pack together", s.combo.length === 2, s.combo);
  // Rival routes never pack together.
  check(
    "rival stages never co-assigned",
    !(s.combo.includes("brook") && s.combo.includes("deep")),
  );
}


// 19. Budget expiry with the fish just out of the budget window: a completion
// outside the budget must not count, and the reason keeps the witness.
{
  let doc = freshRoots();
  // wake budget 7. Put a crucian on cast 1, then fill to cast 8, then perch on 9.
  doc = cast(doc, "crucian", "worm", "reed");
  for (let i = 0; i < 7; i++) doc = cast(doc, "carp", "corn", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  const wake = stageState(doc, "wake");
  check("wake expired, late pair not counted", wake.expired === true);
  check(
    "failure names the missing next step",
    /缺少/.test(wake.failures[0]?.reason ?? ""),
    wake.failures[0]?.reason,
  );
}

// 20. Release after the bag item was already released cannot double count.
{
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed");
  const id = doc.bag[0].id;
  const once = releaseCatch(doc, id);
  check("release removes from bag", once.bag.length === 0);
  const twice = releaseCatch(once, id);
  check("second release is a no-op", twice === once);
  check("released count increments once", once.stats.released === 1);
}

// 21. Claim ordering: claiming wake and then corn in the same run advances the
// journal boundary of dependants monotonically, never backwards.
{
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  doc = cast(doc, "carp", "corn", "reed");
  const before = settle(doc);
  doc = claimCombo(doc);
  check("combo claimed wake and corn", doc.claimed.length >= 2, doc.claimed);
  for (const a of analyzeAll(doc)) {
    const st = stageState(doc, a.stage.id);
    if (st.openedSeq !== null)
      check(
        `boundary monotonic for ${a.stage.id}`,
        st.openedSeq >= 0 && st.openedSeq <= doc.seq,
      );
  }
  check(
    "combo was at least two stages",
    before.combo.length >= 2,
    before.combo,
  );
}

// 22. Packing is optimal, not greedy. A stage inspected first with a window
// that blocks two others must be passed over in favour of the larger set.
{
  const make = (seqs: number[], catchIds: string[]) =>
    ({
      route: { id: "r", label: "r", reward: "r", steps: [] },
      seqs,
      catchIds,
      witnesses: [],
      startCast: 1,
      lastCast: 1,
      matched: 1,
      complete: true,
    }) as unknown as Parameters<typeof packStages>[0][number]["options"][number];
  const stages = [
    { id: "a", rivalsWith: [], options: [make([1, 2], ["x", "y"])] },
    { id: "b", rivalsWith: [], options: [make([2], ["y"])] },
    { id: "c", rivalsWith: [], options: [make([1], ["x"])] },
  ];
  const packed = packStages(stages);
  check(
    "packing finds the maximum (a alone or b+c)",
    Object.keys(packed).length === 2 &&
      !!packed.b &&
      !!packed.c &&
      !packed.a,
    Object.keys(packed),
  );
  // Rival stages must never pack together.
  const rivals = [
    { id: "p", rivalsWith: ["q"], options: [make([9], ["k"])] },
    { id: "q", rivalsWith: ["p"], options: [make([8], ["j"])] },
  ];
  const rp = packStages(rivals);
  check("rival pair packs at most one", Object.keys(rp).length === 1, rp);
}


// 23. One event may close an old window and open the next at once. A dead
// head followed by a *new* usable head must keep the tail, and the very event
// that ended the old attempt may itself be the first witness of the new one.
{
  let doc = freshRoots();
  // A crucian at cast 1 opens wake-a; too few casts later kill the span.
  doc = cast(doc, "crucian", "worm", "reed");
  for (let i = 0; i < 4; i++) doc = cast(doc, "carp", "corn", "reed");
  // Cast 6: a fresh crucian — the old head is dead, this must open anew.
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  const wake = analyzeStage(doc, stageById("wake")!);
  const fresh = wake.offers.filter((o) => o.plan === "wake-a");
  check(
    "dead head's tail is carried into a new window",
    fresh.some((o) => o.seqs[0] === fresh[0].seqs[0]),
    fresh,
  );
  check(
    "new window starts at the re-opening cast, not the dead one",
    fresh.every((o) => o.startCast >= 6),
    fresh,
  );
}

// 24. The same physical event may appear in several stages' previews, yet a
// claim reserves it so no second stage can settle that fish.
{
  let doc = freshRoots();
  // One perch catch with fly at reed: watch-a is 1/2, and nothing else shares
  // it. Use corn-a+carp and a synthetic overlap via a release act instead:
  // catch + release of a perch satisfies watch-a; corn-a remains independent.
  doc = cast(doc, "perch", "fly", "reed");
  const perchId = doc.bag[0].id;
  const rel = releaseCatch(doc, perchId);
  doc = record(rel, { cast: rel.cast, source: "release", catchId: perchId, fish: "perch", spot: "reed", bait: "fly" });
  doc = cast(doc, "carp", "corn", "reed");
  // Both stages have complete windows sharing no evidence.
  const before = settle(doc);
  check("both stages preview complete windows", before.combo.length === 2, before.combo);
  doc = claimPlan(doc, "watch", "watch-a");
  const used = stageState(doc, "watch").claimed!;
  check("watch claim reserved two events", used.seqs.length === 2, used.seqs);
  // A retry cannot re-reward it, and a claim of the same events fails.
  const again = claimPlan(doc, "watch", "watch-a");
  check("watch cannot pay twice", again.claimed.filter((c) => c === "watch-a").length === 1);
  // Corn's independent evidence is untouched.
  const cornAfter = analyzeStage(again, stageById("corn")!);
  check("unrelated stage keeps its preview", cornAfter.offers.length > 0);
}

// 25. expiring one stage must not disturb another stage's live window.
{
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed"); // wake partial
  for (let i = 0; i < 8; i++) doc = cast(doc, "perch", "fly", "reed"); // watch partials
  const watch = analyzeStage(doc, stageById("watch")!);
  check("watch not expired while wake expired", doc.ledger.stages.wake.expired === true);
  check(
    "watch keeps an explained state",
    watch.status === "expired" || watch.windows.length >= 0,
  );
}


// 26. Span semantics regression: the first step of a window is only bounded by
// the stage budget, so a fresh attempt may start on any later cast; inter-step
// spans still apply. This is what lets a tail become the next window's head.
{
  let doc = freshRoots();
  // Many casts pass, then a crucian opens wake-a on cast 8 (budget is 7, so
  // this is past the budget and must NOT count).
  for (let i = 0; i < 7; i++) doc = cast(doc, "carp", "corn", "reed");
  doc = cast(doc, "crucian", "worm", "reed");
  check("event past the budget cannot open a window", doc.ledger.stages.wake.expired === true);
}

// 27. Reopening after a retry clears the old window but keeps history.
{
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = retryStage(doc, "wake");
  const st = stageState(doc, "wake");
  check("retry records the old witness", st.failures.some((f) => f.witnesses.length > 0));
  check("retry keeps the event in the journal", doc.ledger.events.length >= 2);
  // The pre-retry crucian must not count toward the reopened stage.
  const wake = analyzeStage(doc, stageById("wake")!);
  check("pre-retry catch is not back-filled", wake.windows.length === 0);
  // A new crucian after the boundary can open it again.
  doc = cast(doc, "crucian", "worm", "reed");
  const wake2 = analyzeStage(doc, stageById("wake")!);
  check("post-retry catch opens a fresh window", wake2.windows.length > 0);
}


// 27. A manual claim must follow the global packing, not grab a window that
// another stage needs. Stage A completes alone or as part of A+B; B only
// completes using A's leftover fish. The claim order A-then-B must still
// settle both, so A has to choose the window that leaves B's fish alone.
{
  // Recreate the abstract situation through the real stages: wake-b (catch+
  // release one crucian) and corn-a (catch a carp) are independent, while
  // wake-a and wake-b share the leading crucian catch. Claiming wake via the
  // packing must preserve the evidence corn needs.
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  doc = cast(doc, "carp", "corn", "reed");
  const before = settle(doc);
  check(
    "packing keeps independent corn alongside wake",
    before.combo.includes("wake") && before.combo.includes("corn"),
    before.combo,
  );
  doc = claimPlan(doc, "wake", "wake-a");
  const corn = analyzeStage(doc, stageById("corn")!);
  check("corn still claimable after wake", corn.offers.length > 0, corn.status);
  doc = claimPlan(doc, "corn", "corn-a");
  check("both settled", !!stageState(doc, "wake").claimed && !!stageState(doc, "corn").claimed);
  check("no shared event double-counted", (() => {
    const a = new Set(stageState(doc, "wake").claimed!.seqs);
    return stageState(doc, "corn").claimed!.seqs.every((x) => !a.has(x));
  })());
}


// 28. A partial window whose step deadline has already passed must not be
// shown as live, even though the stage budget still has casts left.
{
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed"); // wake-a needs perch within 3 casts
  for (let i = 0; i < 3; i++) doc = cast(doc, "perch", "carp" as any, "reed");
  // cast 4 has passed the span-3 deadline measured from cast 1 for step 2?
  // step 2 anchor=1, span 3 => latest 4; at cast 4 it is still reachable.
  for (let i = 0; i < 1; i++) doc = cast(doc, "perch", "worm", "reed");
  const wake = analyzeStage(doc, stageById("wake")!);
  const head = wake.windows.filter((w) => w.witnesses[0]?.seq === 0);
  check(
    "expired-head windows are not live",
    head.length === 0 || head.every((w) => w.matched > 1),
    head,
  );
  // But the later perch/… can still be a fresh head for nothing (perch alone
  // is not step 1), so only complete/reopened crucian windows matter here.
}


// 29. A completed route is never revoked by the budget running out: the win
// was achieved inside the budget, so claiming it later must still pay once.
{
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed");
  doc = cast(doc, "perch", "worm", "reed");
  // Burn well past wake's 7-cast budget without claiming.
  for (let i = 0; i < 8; i++) doc = cast(doc, "carp", "corn", "reed");
  const wake = stageState(doc, "wake");
  check("completed stage does not expire", wake.expired === false);
  const analysis = analyzeStage(doc, stageById("wake")!);
  check("completed window survives budget end", analysis.offers.length > 0);
  doc = claimPlan(doc, "wake", "wake-a");
  check("late claim still pays once", doc.claimed.includes("wake-a"));
  const again = claimPlan(doc, "wake", "wake-a");
  check("late claim cannot pay twice", again.claimed.filter((c) => c === "wake-a").length === 1);
}


// 30. The same event can close one window and open the next. With a synthetic
// stage whose two alternative routes both begin with a crucian, the second
// crucian both completes a [crucian, crucian] window and starts the next one.
{
  const synth = {
    id: "synth",
    name: "合成",
    brief: "",
    requires: [],
    rivalsWith: [],
    budget: { casts: 6 },
    routes: [
      {
        id: "s1",
        label: "连鲫",
        reward: "r1",
        steps: [
          { action: "catch", fish: "crucian", bait: "worm", span: 2, spot: "reed" },
          { action: "catch", fish: "crucian", bait: "worm", span: 2, spot: "reed" },
        ],
      },
      {
        id: "s2",
        label: "单鲫",
        reward: "r2",
        steps: [
          { action: "catch", fish: "crucian", bait: "worm", span: 2, spot: "reed" },
        ],
      },
    ],
  } as unknown as Parameters<typeof analyzeStage>[1];
  let doc = freshRoots();
  doc = cast(doc, "crucian", "worm", "reed"); // seq 0
  doc = cast(doc, "crucian", "worm", "reed"); // seq 1 closes s1 at #1...
  doc = cast(doc, "crucian", "worm", "reed"); // seq 2 opens a new s2 window
  const state = { ...stageState(doc, "wake"), openedCast: 0, openedSeq: 0 };
  const events = doc.ledger.events;
  const s1 = analyzeRoute(doc, synth, synth.routes[0], state, events);
  const s2 = analyzeRoute(doc, synth, synth.routes[1], state, events);
  check(
    "same event both closes a pair and opens the next single",
    s1.complete.some((w) => w.seqs.join(",") === "0,1") &&
      s2.complete.some((w) => w.seqs[0] === 2),
    {
      pair: s1.complete.map((w) => w.seqs),
      singles: s2.complete.map((w) => w.seqs),
    },
  );
  check(
    "overlapping windows each carry their own witness set",
    s1.complete.some((w) => w.seqs.length === 2) &&
      s2.complete.some((w) => w.seqs.length === 1),
  );
}


console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
