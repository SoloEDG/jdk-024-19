import type {
  Evidence,
  FailureRecord,
  GameDocument,
  StageState,
  TripEvent,
  WatchedAttempt,
  WindowPreview,
} from "../../../shared/types";
import type { ContractRoute, ContractStage } from "../model/contracts";
import {
  contractStages,
  matchStep,
  routeText,
  stepText,
  withinSpan,
} from "../model/contracts";

/**
 * Event matching and cross-stage settlement.
 *
 * Two properties drive the design:
 *
 * 1. Windows are ordered subsequences of the journal. Any event may open a
 *    window, continue one, or be ignored — but failing to continue never
 *    discards the tail: the search starts a new window at every later event,
 *    so the event that closed an old window can still open the next one.
 * 2. Previewing is cheap and shared; settlement is not greedy. Claim choice is
 *    a maximum packing over stages with disjoint evidence, so no stage can take
 *    a fish that is the only way another stage could finish.
 */

export interface RouteWindow {
  route: ContractRoute;
  seqs: number[];
  catchIds: string[];
  witnesses: WatchedAttempt[];
  startCast: number;
  lastCast: number;
  matched: number;
  complete: boolean;
}

export interface RouteAnalysis {
  route: ContractRoute;
  complete: RouteWindow[];
  live: RouteWindow[];
  dead: RouteWindow[];
}

export type StageStatus =
  | "locked"
  | "active"
  | "claimed"
  | "abandoned"
  | "expired";

export interface StageAnalysis {
  stage: ContractStage;
  state: StageState;
  status: StageStatus;
  lock: string | null;
  offers: Evidence[];
  windows: WindowPreview[];
  routes: RouteAnalysis[];
  /** Best witness set for a failure explanation. */
  bestWitnesses: WatchedAttempt[];
  failures: FailureRecord[];
}

export function emptyStage(): StageState {
  return {
    openedSeq: null,
    openedCast: null,
    attempts: 0,
    claimed: null,
    abandoned: false,
    abandonedReason: null,
    expired: false,
    expiredAtCast: null,
    offers: [],
    windows: [],
    failures: [],
    failuresDropped: 0,
    trace: [],
    traceDropped: 0,
  };
}

export function stageState(doc: GameDocument, id: string): StageState {
  return doc.ledger.stages[id] ?? emptyStage();
}

export function stageOpen(doc: GameDocument, stage: ContractStage) {
  const all = stage.requires.every((id) => !!stageState(doc, id).claimed);
  const any =
    !stage.requiresAny ||
    stage.requiresAny.length === 0 ||
    stage.requiresAny.some((id) => !!stageState(doc, id).claimed);
  return all && any;
}

export function stageLive(doc: GameDocument, stage: ContractStage) {
  const st = stageState(doc, stage.id);
  return stageOpen(doc, stage) && !st.claimed && !st.abandoned && !st.expired;
}

export function stageById(id: string) {
  return contractStages.find((s) => s.id === id) ?? null;
}

export function stageLock(doc: GameDocument, stage: ContractStage) {
  if (stageOpen(doc, stage)) return null;
  const missing = stage.requires.filter((id) => !stageState(doc, id).claimed);
  if (missing.length > 0)
    return `需先领取：${missing.map((id) => stageById(id)?.name ?? id).join("、")}`;
  const anyLeft =
    stage.requiresAny?.filter((id) => !stageState(doc, id).claimed) ?? [];
  return `需先领取：${anyLeft.map((id) => stageById(id)?.name ?? id).join(" 或 ")}`;
}

export function withStage(
  doc: GameDocument,
  id: string,
  state: StageState,
): GameDocument {
  return {
    ...doc,
    ledger: {
      ...doc.ledger,
      stages: { ...doc.ledger.stages, [id]: state },
    },
  };
}

export function eventsForStage(doc: GameDocument, stage: ContractStage) {
  const st = stageState(doc, stage.id);
  if (st.openedSeq === null) return [];
  return doc.ledger.events.filter((e) => e.seq >= st.openedSeq!);
}

/* ------------------------------------------------------------------ */
/* Window enumeration                                                  */
/* ------------------------------------------------------------------ */

/**
 * Enumerate every ordered subsequence matching the route inside the cast
 * budget. Every prefix is recorded, which is how a still-usable tail appears
 * as its own window even after an earlier head died. Deduped by event set and
 * capped so UI cost stays bounded.
 */
function enumerate(
  route: ContractRoute,
  events: TripEvent[],
  openedCast: number,
  budget: number,
  cap = 400,
): RouteWindow[] {
  const out: RouteWindow[] = [];
  const seen = new Set<string>();
  const maxCast = openedCast + budget;
  let visits = 0;

  const record = (
    witnesses: WatchedAttempt[],
    seqs: number[],
    catchIds: string[],
    startCast: number,
    lastCast: number,
    complete: boolean,
  ) => {
    if (witnesses.length === 0) return;
    const key = seqs.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      route,
      seqs,
      catchIds: [...new Set(catchIds)],
      witnesses,
      startCast,
      lastCast,
      matched: witnesses.length,
      complete,
    });
  };

  const walk = (
    stepIndex: number,
    from: number,
    prevCast: number | null,
    witnesses: WatchedAttempt[],
    seqs: number[],
    catchIds: string[],
    startCast: number,
    lastCast: number,
  ) => {
    if (visits++ > cap) return;
    if (witnesses.length > 0) {
      record(
        witnesses,
        seqs,
        catchIds,
        startCast,
        lastCast,
        stepIndex >= route.steps.length,
      );
    }
    if (stepIndex >= route.steps.length) return;
    const step = route.steps[stepIndex];
    const expectedCatchId = catchIds.length
      ? catchIds[catchIds.length - 1]
      : null;
    for (let j = from; j < events.length; j++) {
      const e = events[j];
      if (e.cast > maxCast) break; // cast is non-decreasing in seq order
      if (!withinSpan(step, e, prevCast, openedCast, budget)) continue;
      if (matchStep(step, e, expectedCatchId) !== "ok") continue;
      const w: WatchedAttempt = {
        seq: e.seq,
        cast: e.cast,
        fish: e.fish!,
        spot: e.spot,
        bait: e.bait,
        source: e.source,
        catchId: e.catchId,
      };
      walk(
        stepIndex + 1,
        j + 1,
        e.cast,
        [...witnesses, w],
        [...seqs, e.seq],
        step.action === "catch" && e.catchId
          ? [...catchIds, e.catchId]
          : catchIds,
        witnesses.length === 0 ? e.cast : startCast,
        e.cast,
      );
    }
  };

  walk(0, 0, null, [], [], [], 0, 0);
  return out;
}

/**
 * Can a partial window still finish?
 *
 * A window with a head is extended only by further ordered events: the next
 * step must land within its span of the last committed cast, and every later
 * step within its own span, all still inside the stage budget. A release step
 * may share the cast of the fish it returns; a catch needs a fresh cast.
 * (A window with no head is bounded only by the budget, which is why any later
 * event may still open the next attempt.)
 */
export function canStillComplete(
  route: ContractRoute,
  fromStep: number,
  prevCast: number | null,
  openedCast: number,
  budget: number,
  currentCast: number,
): boolean {
  if (fromStep >= route.steps.length) return true;
  const end = openedCast + budget;
  // Future events always have cast >= currentCast + 1.
  const soonest = currentCast + 1;
  if (prevCast === null) return soonest <= end;
  let anchor = prevCast;
  for (let i = fromStep; i < route.steps.length; i++) {
    const step = route.steps[i];
    // A release may share its catch's cast; a catch needs a new cast.
    const earliest = Math.max(
      step.action === "release" ? anchor : anchor + 1,
      soonest,
    );
    const latest = Math.min(anchor + step.span, end);
    if (earliest > latest) return false;
    anchor = earliest;
  }
  return true;
}

function previewFor(
  route: ContractRoute,
  w: RouteWindow,
  openedCast: number,
  budget: number,
  currentCast: number,
): WindowPreview {
  const next = route.steps[w.matched];
  const anchor = w.matched === 0 ? null : w.lastCast;
  const latest = next
    ? Math.min(
        (anchor === null ? openedCast : anchor) + next.span,
        openedCast + budget,
      )
    : w.lastCast;
  const remaining = Math.max(0, openedCast + budget - currentCast);
  return {
    plan: route.id,
    label: route.label,
    startSeq: w.seqs[0] ?? 0,
    startCast: w.startCast,
    witnesses: w.witnesses,
    matched: w.matched,
    total: route.steps.length,
    remainingCasts: remaining,
    text: next
      ? `下一步：${stepText(next)}；最迟第 ${latest} 竿，预算还剩 ${remaining} 竿。`
      : routeText(route),
  };
}

export function analyzeRoute(
  doc: GameDocument,
  stage: ContractStage,
  route: ContractRoute,
  state: StageState,
  events: TripEvent[],
): RouteAnalysis {
  const openedCast = state.openedCast ?? 0;
  const all = enumerate(route, events, openedCast, stage.budget.casts).sort(
    (a, b) => {
      if (a.complete !== b.complete) return a.complete ? -1 : 1;
      if (a.matched !== b.matched) return b.matched - a.matched;
      return b.lastCast - a.lastCast;
    },
  );
  const complete = all.filter((w) => w.complete);
  const partial = all.filter((w) => !w.complete);
  const live = partial
    .filter((w) =>
      canStillComplete(
        route,
        w.matched,
        w.matched === 0 ? null : w.lastCast,
        openedCast,
        stage.budget.casts,
        doc.cast,
      ),
    )
    .sort((a, b) => {
      if (a.matched !== b.matched) return b.matched - a.matched;
      return b.lastCast - a.lastCast;
    })
    .slice(0, 3);
  const dead = partial
    .filter((w) => !live.includes(w))
    .sort((a, b) => {
      if (a.matched !== b.matched) return b.matched - a.matched;
      return b.lastCast - a.lastCast;
    })
    .slice(0, 3);
  return {
    route,
    complete: complete.slice(0, 8),
    live,
    dead,
  };
}

export function analyzeStage(
  doc: GameDocument,
  stage: ContractStage,
): StageAnalysis {
  const state = stageState(doc, stage.id);
  const status: StageStatus = state.claimed
    ? "claimed"
    : state.abandoned
      ? "abandoned"
      : state.expired
        ? "expired"
        : !stageOpen(doc, stage)
          ? "locked"
          : "active";
  const events = status === "active" ? eventsForStage(doc, stage) : [];
  const routes =
    status === "active"
      ? stage.routes.map((route) =>
          analyzeRoute(doc, stage, route, state, events),
        )
      : [];
  const windows = routes
    .flatMap((r) =>
      r.live.map((w) =>
        previewFor(r.route, w, state.openedCast ?? 0, stage.budget.casts, doc.cast),
      ),
    )
    .sort((a, b) => {
      if (a.matched !== b.matched) return b.matched - a.matched;
      return b.startCast - a.startCast;
    })
    .slice(0, 4);
  const offers =
    status === "active"
      ? routes.flatMap((r) =>
          r.complete.map<Evidence>((w) => ({
            plan: w.route.id,
            seqs: w.seqs,
            catchIds: w.catchIds,
            witnesses: w.witnesses,
            startCast: w.startCast,
            lastCast: w.lastCast,
          })),
        )
      : state.offers;
  const bestWitnesses =
    routes
      .flatMap((r) => [...r.complete, ...r.live, ...r.dead])
      .sort((a, b) => {
        if (a.matched !== b.matched) return b.matched - a.matched;
        return b.lastCast - a.lastCast;
      })[0]?.witnesses ?? state.trace;
  return {
    stage,
    state,
    status,
    lock: stageLock(doc, stage),
    offers,
    windows,
    routes,
    bestWitnesses,
    failures: state.failures,
  };
}

const analysisCache = new WeakMap<GameDocument, StageAnalysis[]>();

/**
 * Memoised per document object. The reducer replaces the document on every
 * journal act but leaves it untouched during 50 ms game ticks, so the panel can
 * re-render without re-enumerating windows.
 */
export function analyzeAll(doc: GameDocument): StageAnalysis[] {
  const hit = analysisCache.get(doc);
  if (hit) return hit;
  const result = contractStages.map((stage) => analyzeStage(doc, stage));
  analysisCache.set(doc, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Persisting bounded process evidence                                 */
/* ------------------------------------------------------------------ */

function witnessTrace(a: StageAnalysis) {
  const all = a.routes.flatMap((r) =>
    [...r.complete, ...r.live, ...r.dead].flatMap((w) => w.witnesses),
  );
  const seen = new Set<number>();
  return all
    .sort((x, y) => y.seq - x.seq)
    .filter((w) => {
      if (seen.has(w.seq)) return false;
      seen.add(w.seq);
      return true;
    });
}

/**
 * Stamp root stages (no prerequisites) at the document's true beginning. This
 * must run once at load, before any cast, so the first event is not skipped by
 * a boundary stamped at the end of that same cast. For an already-played
 * document the boundary is "now", which is exactly the no-back-fill rule.
 */
export function initDocument(doc: GameDocument): GameDocument {
  let next = doc;
  const fresh = doc.seq === 0 && doc.cast === 0;
  for (const stage of contractStages) {
    const st = stageState(next, stage.id);
    if (st.openedSeq !== null) continue;
    if (stage.requires.length > 0 || (stage.requiresAny?.length ?? 0) > 0)
      continue;
    next = withStage(next, stage.id, {
      ...st,
      openedSeq: fresh ? 0 : next.seq,
      openedCast: fresh ? 0 : next.cast,
    });
  }
  return next;
}

/**
 * Recompute offers/windows and stamp newly opened stages at the current
 * journal boundary. Existing failures and claims are never rewritten.
 */
export function syncStages(doc: GameDocument): GameDocument {
  let next = doc;
  // Open stages in dependency order at one boundary.
  for (const stage of contractStages) {
    const st = stageState(next, stage.id);
    if (st.openedSeq !== null) continue;
    if (!stageOpen(next, stage)) continue;
    next = withStage(next, stage.id, {
      ...st,
      openedSeq: next.seq,
      openedCast: next.cast,
    });
  }

  for (const analysis of analyzeAll(next)) {
    const { stage, state } = analysis;
    if (analysis.status !== "active") continue;
    const offers = analysis.offers.slice(0, 8);
    const windows = analysis.windows;
    const fresh = witnessTrace(analysis).slice(0, 8);
    const known = new Set(fresh.map((w) => w.seq));
    const older = state.trace.filter((w) => !known.has(w.seq));
    const trace = [...fresh, ...older].slice(0, 8);
    let updated: StageState = {
      ...state,
      offers,
      windows,
      trace,
      traceDropped:
        state.traceDropped + Math.max(0, fresh.length + older.length - trace.length),
    };

    // Budget closed with no complete route: freeze once and explain why.
    // A stage with an unclaimed complete window that reaches the budget end is
    // left alone: claiming it later still works, and expiry must not eat a win.
    const overBudget =
      state.openedCast !== null &&
      next.cast - state.openedCast > stage.budget.casts;
    if (overBudget && offers.length === 0 && !updated.expired) {
      const detail = analysis.routes
        .map((r) => {
          const top = r.live[0] ?? r.dead[0];
          if (!top) return `「${r.route.label}」没有形成可用窗口`;
          const nextStep = r.route.steps[top.matched];
          const last = top.witnesses[top.witnesses.length - 1];
          return (
            `「${r.route.label}」${top.matched}/${r.route.steps.length} 步` +
            (nextStep
              ? `，缺少${stepText(nextStep)}${last ? `（最后见证 #${last.seq}）` : ""}`
              : "")
          );
        })
        .join("；");
      const failure: FailureRecord = {
        attempt: state.attempts + 1,
        atSeq: next.seq,
        atCast: next.cast,
        reason: `预算 ${stage.budget.casts} 竿用尽仍未完成：${detail}。`,
        witnesses: analysis.bestWitnesses.slice(0, 4),
      };
      updated = {
        ...updated,
        expired: true,
        expiredAtCast: next.cast,
        attempts: state.attempts + 1,
        failures: [failure, ...state.failures].slice(0, 5),
        failuresDropped:
          state.failuresDropped +
          Math.max(0, state.failures.length + 1 - 5),
      };
    }
    next = withStage(next, stage.id, updated);
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Cross-stage settlement                                              */
/* ------------------------------------------------------------------ */

export interface Settlement {
  /** stage id -> the window that stage would submit. */
  assignments: Record<string, RouteWindow>;
  /** Stages that can all be claimed together, in prerequisite-safe order. */
  combo: string[];
  /** Live stages with a completion that cannot fit the combo, with reasons. */
  conflicts: Record<string, string>;
  /** Evidence already reserved by claims or the chosen combo. */
  reservedSeqs: Set<number>;
  reservedCatchIds: Set<string>;
}

function depth(stage: ContractStage) {
  return stage.requires.length;
}

function candidatesFor(a: StageAnalysis): RouteWindow[] {
  const windows = a.routes.flatMap((r) => r.complete);
  const seen = new Set<string>();
  const picked: RouteWindow[] = [];
  const sorted = [...windows].sort(
    (x, y) => x.lastCast - y.lastCast || x.startCast - y.startCast,
  );
  for (const w of sorted) {
    const signature = `${w.catchIds.slice().sort().join(",")}|${w.seqs.join(",")}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    picked.push(w);
    if (picked.length >= 6) break;
  }
  return picked;
}

/**
 * Maximum set of live stages that can claim at once with disjoint evidence and
 * no rival route submitted twice. Exhaustive over the small stage × window
 * space, so a greedy first stage cannot hide a different complete solution.
 */
const settleCache = new WeakMap<GameDocument, Settlement>();

export function settle(doc: GameDocument): Settlement {
  const hit = settleCache.get(doc);
  if (hit) return hit;
  const result = computeSettlement(doc);
  settleCache.set(doc, result);
  return result;
}

/**
 * Exhaustive packing over stages (branch and bound). A greedy walk would take
 * the first inspected stage's window and could hide a different full solution,
 * so the solver always explores "leave this stage out" as well, and only then
 * tries each of its completions.
 */
export function packStages(
  stages: { id: string; rivalsWith: string[]; options: RouteWindow[] }[],
  reservedSeqs: Set<number> = new Set(),
  reservedCatchIds: Set<string> = new Set(),
): Record<string, RouteWindow> {
  const order = [...stages].sort((a, b) => a.id.localeCompare(b.id));
  let chosen: Record<string, RouteWindow> = {};
  let best: Record<string, RouteWindow> = {};
  const usedSeqs = new Set(reservedSeqs);
  const usedCatchIds = new Set(reservedCatchIds);
  const chosenStages = new Set<string>();

  const fits = (w: RouteWindow) =>
    w.seqs.every((s) => !usedSeqs.has(s)) &&
    w.catchIds.every((c) => !usedCatchIds.has(c));

  const search = (index: number) => {
    // Branch and bound: taking everything left cannot beat the current best.
    if (
      Object.keys(chosen).length + (order.length - index) <
      Object.keys(best).length
    )
      return;
    if (index >= order.length) {
      const n = Object.keys(chosen).length;
      if (
        n > Object.keys(best).length ||
        (n === Object.keys(best).length &&
          Object.keys(chosen).sort().join(",") <
            Object.keys(best).sort().join(","))
      )
        best = { ...chosen };
      return;
    }
    const stage = order[index];
    // Option 1: leave this stage out. This is what keeps the result optimal.
    search(index + 1);
    // Option 2: submit one of its completions.
    if (stage.rivalsWith.some((r) => chosenStages.has(r))) return;
    for (const w of stage.options) {
      if (!fits(w)) continue;
      chosen[stage.id] = w;
      chosenStages.add(stage.id);
      for (const s of w.seqs) usedSeqs.add(s);
      for (const c of w.catchIds) usedCatchIds.add(c);
      search(index + 1);
      for (const s of w.seqs) usedSeqs.delete(s);
      for (const c of w.catchIds) usedCatchIds.delete(c);
      chosenStages.delete(stage.id);
      delete chosen[stage.id];
    }
  };
  search(0);
  return best;
}

function computeSettlement(doc: GameDocument): Settlement {
  const reservedSeqs = new Set<number>();
  const reservedCatchIds = new Set<string>();
  for (const st of Object.values(doc.ledger.stages)) {
    if (!st.claimed) continue;
    for (const seq of st.claimed.seqs) reservedSeqs.add(seq);
    for (const id of st.claimed.catchIds) reservedCatchIds.add(id);
  }

  const live = contractStages
    .map((stage) => analyzeStage(doc, stage))
    .filter((a) => a.status === "active");
  const options = new Map<string, RouteWindow[]>();
  for (const a of live) options.set(a.stage.id, candidatesFor(a));

  const assignments = packStages(
    live.map((a) => ({
      id: a.stage.id,
      rivalsWith: a.stage.rivalsWith,
      options: options.get(a.stage.id) ?? [],
    })),
    reservedSeqs,
    reservedCatchIds,
  );

  const combo = Object.keys(assignments).sort((a, b) => {
    const sa = contractStages.find((s) => s.id === a)!;
    const sb = contractStages.find((s) => s.id === b)!;
    return depth(sa) - depth(sb) || a.localeCompare(b);
  });

  const conflicts: Record<string, string> = {};
  for (const a of live) {
    if (assignments[a.stage.id]) continue;
    const here = options.get(a.stage.id) ?? [];
    if (here.length === 0) continue;
    const rival = a.stage.rivalsWith
      .map((r) => contractStages.find((s) => s.id === r))
      .find((r) => r && assignments[r.id]);
    conflicts[a.stage.id] = rival
      ? `与已提交的互斥路线「${rival.name}」不能同时领奖。`
      : here.every((w) => [...w.seqs].some((s) => reservedSeqs.has(s)))
        ? "这批见证事件已归其他契约结算；同一尾鱼只能正式归属一个阶段。"
        : "可完成的窗口与其他阶段重叠；同时领取会少一份奖励，已优先保证阶段数最多。";
  }

  const finalSeqs = new Set<number>(reservedSeqs);
  const finalCatchIds = new Set<string>(reservedCatchIds);
  for (const w of Object.values(assignments)) {
    for (const s of w.seqs) finalSeqs.add(s);
    for (const c of w.catchIds) finalCatchIds.add(c);
  }
  return {
    assignments,
    combo,
    conflicts,
    reservedSeqs: finalSeqs,
    reservedCatchIds: finalCatchIds,
  };
}

/* ------------------------------------------------------------------ */
/* Claim helpers                                                       */
/* ------------------------------------------------------------------ */

export function usedEvidence(doc: GameDocument, exceptStage?: string) {
  const seqs = new Set<number>();
  const catchIds = new Set<string>();
  for (const [id, st] of Object.entries(doc.ledger.stages)) {
    if (id === exceptStage || !st.claimed) continue;
    for (const s of st.claimed.seqs) seqs.add(s);
    for (const c of st.claimed.catchIds) catchIds.add(c);
  }
  return { seqs, catchIds };
}

/** Pick the earliest complete window that does not clash with other claims. */
export function claimableWindow(
  doc: GameDocument,
  stage: ContractStage,
  planId: string,
): RouteWindow | null {
  const a = analyzeStage(doc, stage);
  const route = a.routes.find((r) => r.route.id === planId);
  if (!route) return null;
  const used = usedEvidence(doc, stage.id);
  const free = route.complete
    .filter(
      (w) =>
        w.seqs.every((s) => !used.seqs.has(s)) &&
        w.catchIds.every((c) => !used.catchIds.has(c)),
    )
    .sort((x, y) => x.lastCast - y.lastCast || x.startCast - y.startCast);
  return free[0] ?? null;
}
