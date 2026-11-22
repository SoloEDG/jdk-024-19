import type {
  ClaimRecord,
  GameDocument,
  PendingCast,
  TripEvent,
} from "../../../shared/types";
import type { ContractStage } from "../model/contracts";
import { contractStages, routeById } from "../model/contracts";
import {
  analyzeStage,
  claimableWindow,
  initDocument,
  settle,
  usedEvidence,
  stageById,
  stageOpen,
  stageState,
  syncStages,
  withStage,
} from "./match";

/**
 * Journal mutations. Every way a cast can end funnels through `record`, which
 * assigns the next seq before any stage sees the act. That is the single order
 * the whole feature depends on — release, escape, contract switch, refresh and
 * reconnect all advance it identically.
 */

const MAX_FAILURES = 5;

export function note(doc: GameDocument, text: string): GameDocument {
  return { ...doc, notes: [...doc.notes.slice(-2), text] };
}

/** Append one ordered act without recomputing stages. Never renumbers. */
function append(
  doc: GameDocument,
  act: Omit<TripEvent, "seq">,
): GameDocument {
  const event: TripEvent = { ...act, seq: doc.seq };
  return {
    ...doc,
    seq: doc.seq + 1,
    ledger: { ...doc.ledger, events: [...doc.ledger.events, event] },
  };
}

/** Append one ordered act and let every stage see it. Never renumbers. */
export function record(
  doc: GameDocument,
  act: Omit<TripEvent, "seq">,
): GameDocument {
  return syncStages(append(doc, act));
}

/** Start a cast: reserve its number and remember enough to finish it on load. */
export function beginCast(doc: GameDocument, pending: PendingCast): GameDocument {
  return { ...doc, cast: pending.cast, pending };
}

/**
 * Settle the cast in flight. Landed, released and escaped fish all reach the
 * ledger through here, so a release of a fish caught in the same cast is
 * ordered after its catch.
 */
export function settlePending(
  doc: GameDocument,
  act: Omit<TripEvent, "seq" | "cast">,
): GameDocument {
  const cast = doc.pending?.cast ?? doc.cast;
  return record({ ...doc, pending: null }, { cast, ...act });
}

/**
 * A refresh, tab close or reconnect with a cast in flight still advances the
 * order exactly once; the act is "interrupted", not rolled back.
 */
export function recoverDocument(doc: GameDocument): GameDocument {
  let next = syncStages(initDocument(doc));
  if (!next.pending) return next;
  const p = next.pending;
  next = record(
    { ...next, pending: null },
    {
      cast: p.cast,
      source: "aborted",
      catchId: p.catchId,
      fish: p.fish,
      spot: p.spot,
      bait: p.bait,
    },
  );
  return note(next, "上一竿因刷新或断线中断，手记已按顺序记下一次空收。");
}

/* ------------------------------------------------------------------ */
/* Claiming                                                            */
/* ------------------------------------------------------------------ */

function abandon(
  doc: GameDocument,
  stage: ContractStage,
  reason: string,
): GameDocument {
  const st = stageState(doc, stage.id);
  if (st.claimed || st.abandoned) return doc;
  const analysis = analyzeStage(doc, stage);
  return withStage(doc, stage.id, {
    ...st,
    abandoned: true,
    abandonedReason: reason,
    attempts: st.attempts + 1,
    failures: [
      {
        attempt: st.attempts + 1,
        atSeq: doc.seq,
        atCast: doc.cast,
        reason,
        witnesses: analysis.bestWitnesses.slice(0, 4),
      },
      ...st.failures,
    ].slice(0, MAX_FAILURES),
    failuresDropped:
      st.failuresDropped + Math.max(0, st.failures.length + 1 - MAX_FAILURES),
  });
}

/**
 * Claim one route.
 * - A claimed stage never pays twice and never consumes a second witness.
 * - Rival routes are abandoned on submission, even if already complete; a
 *   claimed rival is never rolled back.
 * - Dependants open *after* this claim's boundary, so no earlier catch counts.
 */
export function claimPlan(
  doc: GameDocument,
  stageId: string,
  planId: string,
): GameDocument {
  const stage = stageById(stageId);
  if (!stage) return note(doc, "没有找到这份契约。");
  const st = stageState(doc, stageId);
  if (st.claimed)
    return note(
      doc,
      `${stage.name}已领取「${st.claimed.reward}」，不会重复发放，也不会再消耗见证事件。`,
    );
  if (st.abandoned)
    return note(
      doc,
      `${stage.name}已放弃：${st.abandonedReason ?? "互斥路线已提交"}。`,
    );
  if (!stageOpen(doc, stage))
    return note(doc, `${stage.name}的前置契约尚未领奖，暂时不能提交。`);

  const fresh = syncStages(doc);
  if (stageState(fresh, stageId).expired)
    return note(doc, `${stage.name}的预算已用尽，请重试这一阶段后再提交。`);
  const route = routeById(stage, planId);
  if (!route) return note(doc, "没有找到这条路线。");

  // Prefer the window the global packing assigned to this stage. A manual
  // claim must not greedily take evidence that another stage needs for the
  // only combination that settles everyone; the packing already proved which
  // windows can coexist.
  const free = usedEvidence(fresh, stageId);
  const assigned = settle(fresh).assignments[stageId];
  const window =
    assigned &&
    assigned.route.id === planId &&
    assigned.seqs.every((q) => !free.seqs.has(q)) &&
    assigned.catchIds.every((c) => !free.catchIds.has(c))
      ? assigned
      : claimableWindow(fresh, stage, planId);
  if (!window)
    return note(
      doc,
      `「${route.label}」没有可提交的完整窗口；所需见证事件可能已归另一个阶段结算。`,
    );

  const claim: ClaimRecord = {
    stage: stageId,
    plan: planId,
    reward: route.reward,
    seqs: window.seqs,
    catchIds: window.catchIds,
    witnesses: window.witnesses,
    atSeq: doc.seq,
    at: Date.now(),
  };
  let next = withStage(fresh, stageId, {
    ...stageState(fresh, stageId),
    claimed: claim,
    offers: [],
    windows: [],
  });
  if (!next.claimed.includes(planId))
    next = { ...next, claimed: [...next.claimed, planId] };

  for (const rivalId of stage.rivalsWith) {
    const rival = stageById(rivalId);
    if (!rival) continue;
    next = abandon(
      next,
      rival,
      `${stage.name}已提交「${route.label}」并领取「${route.reward}」；` +
        `互斥路线${rival.name}未领奖即放弃，不再补发。`,
    );
  }
  next = syncStages(next);
  return note(
    next,
    `已领取「${route.reward}」；见证事件 ${window.seqs.map((s) => `#${s}`).join("、")}。`,
  );
}

/**
 * Claim a whole settlement combo in prerequisite order. Each stage is claimed
 * against the document produced by the previous one, so opening boundaries
 * advance monotonically and no stage re-uses another's evidence.
 */
export function claimCombo(doc: GameDocument): GameDocument {
  const { combo, assignments } = settle(doc);
  if (combo.length === 0)
    return note(doc, "当前没有能同时领取的完整窗口。");
  let next = doc;
  const rewards: string[] = [];
  for (const stageId of combo) {
    const w = assignments[stageId];
    if (!w) continue;
    next = claimPlan(next, stageId, w.route.id);
    const claimed = stageState(next, stageId).claimed;
    if (claimed) rewards.push(claimed.reward);
  }
  return note(
    next,
    rewards.length > 0
      ? `同时领取 ${rewards.length} 份：「${rewards.join("」「")}」，每个阶段只结算一次。`
      : "没有成功领取任何阶段。",
  );
}

/* ------------------------------------------------------------------ */
/* Retry and route switch                                              */
/* ------------------------------------------------------------------ */

function reopen(
  doc: GameDocument,
  stageId: string,
  kind: "retry" | "switch",
): GameDocument {
  const stage = stageById(stageId);
  if (!stage) return note(doc, "没有找到这份契约。");
  const st = stageState(doc, stageId);
  if (!stageOpen(doc, stage))
    return note(doc, `${stage.name}的前置契约尚未领奖，还没有打开。`);
  if (st.claimed)
    return note(
      doc,
      `${stage.name}已领奖，${kind === "retry" ? "重试" : "换约"}不会回滚已领的奖励。`,
    );
  if (st.abandoned)
    return note(doc, `${stage.name}已因互斥路线放弃，不能再重开。`);

  const analysis = analyzeStage(doc, stage);
  const best = [...analysis.routes]
    .flatMap((r) => [...r.complete, ...r.live, ...r.dead])
    .sort((a, b) => b.matched - a.matched || b.lastCast - a.lastCast)[0];
  // Preserve the bounded process record: the compressed journal must keep
  // explaining every active window and failure, not just the newest one.
  const reason = best
    ? `${kind === "retry" ? "重试" : "换约"}只重开「${stage.name}」；旧窗口「${best.route.label}」` +
      `${best.matched}/${best.route.steps.length} 步` +
      `${best.witnesses.length ? `（${best.witnesses.map((w) => `#${w.seq}`).join("、")}）` : ""}不再补算。`
    : `${kind === "retry" ? "重试" : "换约"}只重开「${stage.name}」；旧窗口没有形成有效开头。`;

  // Append the act without syncing first: syncing against the old boundary
  // would immediately re-expire the stage and file a second, misleading
  // failure, before we get a chance to stamp the fresh boundary.
  let next = append(doc, {
    cast: doc.cast,
    source: kind,
    catchId: null,
    fish: null,
    spot: doc.spot,
    bait: doc.bait,
  });
  const after = stageState(next, stageId);
  next = withStage(next, stageId, {
    ...after,
    openedSeq: next.seq,
    openedCast: next.cast,
    expired: false,
    expiredAtCast: null,
    attempts: after.attempts + 1,
    offers: [],
    windows: [],
    failures: [
      {
        attempt: after.attempts + 1,
        atSeq: next.seq,
        atCast: next.cast,
        reason,
        // Every still-live window of the reopened stage, so compression cannot
        // erase which witnesses the old attempt held or why it stopped.
        witnesses:
          best?.witnesses.slice(0, 4) ??
          analysis.windows.flatMap((w) => w.witnesses).slice(0, 4),
      },
      ...after.failures,
    ].slice(0, MAX_FAILURES),
    failuresDropped:
      after.failuresDropped +
      Math.max(0, after.failures.length + 1 - MAX_FAILURES),
  });
  next = syncStages(next);
  return note(
    next,
    `${stage.name}${kind === "retry" ? "已重试" : "已换约"}，只重开该阶段；其他阶段与已领奖励不变。`,
  );
}

export function retryStage(doc: GameDocument, stageId: string) {
  return reopen(doc, stageId, "retry");
}

export function switchRoute(doc: GameDocument, stageId: string) {
  return reopen(doc, stageId, "switch");
}

/* ------------------------------------------------------------------ */
/* Journal compression                                                 */
/* ------------------------------------------------------------------ */

/**
 * Drop raw acts only when no active stage can still use them. The floor is the
 * earliest opening boundary among active stages, so every explainable window
 * keeps its witness events. Settled or abandoned stages keep their witnesses in
 * their own bounded records (≤5 failures, ≤8 trace), so compression never
 * degrades an explanation into a bare count.
 */
export function trimLedger(doc: GameDocument): GameDocument {
  const floors = contractStages
    .map((stage) => stageState(doc, stage.id))
    .filter(
      (st) =>
        st.openedSeq !== null && !st.claimed && !st.abandoned && !st.expired,
    )
    .map((st) => st.openedSeq!);
  if (floors.length === 0) {
    if (doc.ledger.events.length === 0) return doc;
    const last = doc.ledger.events[doc.ledger.events.length - 1].seq;
    return {
      ...doc,
      ledger: {
        ...doc.ledger,
        events: [],
        trim: {
          throughSeq: last,
          dropped: (doc.ledger.trim?.dropped ?? 0) + doc.ledger.events.length,
          kept: 0,
          at: Date.now(),
        },
      },
    };
  }
  const floor = Math.min(...floors);
  const found = doc.ledger.events.findIndex((e) => e.seq >= floor);
  const cut = found === -1 ? doc.ledger.events.length : found;
  if (cut <= 0) return doc;
  const dropped = doc.ledger.events.slice(0, cut);
  return {
    ...doc,
    ledger: {
      ...doc.ledger,
      events: doc.ledger.events.slice(cut),
      trim: {
        throughSeq: dropped[dropped.length - 1].seq,
        dropped: (doc.ledger.trim?.dropped ?? 0) + dropped.length,
        kept: doc.ledger.events.length - cut,
        at: Date.now(),
      },
    },
  };
}

export {
  initDocument,
  stageOpen,
  stageLive,
  stageById,
  stageState,
  syncStages,
} from "./match";
export { analyzeAll } from "./match";
export type { StageState } from "../../../shared/types";
