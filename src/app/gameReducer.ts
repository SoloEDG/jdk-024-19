import type { Workspace } from "../shared/types";
import type { Command } from "../shared/commands";
import { idleSession, isBusy } from "../shared/initial";
import { selectWater } from "../features/waters";
import {
  chooseBait,
  tune,
  consumeBait,
  resupply,
  attraction,
  biteDelay,
} from "../features/tackle";
import { prepareCast, tickSession, strike } from "../features/fishing";
import { landCatch, releaseCatch } from "../features/collection";
import {
  beginCast,
  claimCombo,
  claimPlan,
  record,
  retryStage,
  settlePending,
  switchRoute,
  trimLedger,
} from "../features/challenges";

export function gameReducer(state: Workspace, c: Command): Workspace {
  const next = reduce(state, c);
  // A refusal explains itself once: surface only a newly appended note.
  // Notes are capped at 3, so compare the tail text rather than the length.
  const before = state.doc.notes[state.doc.notes.length - 1];
  const after = next.doc.notes[next.doc.notes.length - 1];
  if (after && after !== before) return { ...next, notice: after };
  return next;
}

function reduce(state: Workspace, c: Command): Workspace {
  const { doc, session: s } = state;
  const busy = isBusy(s);
  switch (c.type) {
    case "spot":
      return busy ? state : { ...state, doc: selectWater(doc, c.id) };
    case "bait":
      return busy ? state : { ...state, doc: chooseBait(doc, c.id) };
    case "power":
      return { ...state, doc: tune(doc, "power", c.value) };
    case "drag":
      return busy ? state : { ...state, doc: tune(doc, "drag", c.value) };
    case "resupply":
      return busy
        ? state
        : {
            ...state,
            doc: resupply(doc),
            notice: "鱼饵已补给，带上好心情出发。",
          };
    case "charge-start":
      return s.phase === "ready" && doc.stock[doc.bait] > 0
        ? {
            ...state,
            session: {
              ...idleSession(),
              phase: "charging",
              message: "再次点击，把鱼饵抛向水面。",
            },
          }
        : state;
    case "cast": {
      if (s.phase !== "charging") return state;
      const consumed = consumeBait(doc);
      if (!consumed) return state;
      const castNo = consumed.cast + 1;
      const cast = prepareCast(
        consumed,
        s.charge,
        attraction(consumed.spot, consumed.bait),
        (r) => biteDelay(consumed.bait, r),
      );
      return {
        ...state,
        doc: beginCast(
          {
            ...consumed,
            seed: cast.seed,
            stats: { ...consumed.stats, casts: consumed.stats.casts + 1 },
          },
          {
            cast: castNo,
            catchId: cast.session.id,
            fish: cast.session.fish,
            spot: cast.session.spot,
            bait: cast.session.bait,
          },
        ),
        session: cast.session,
      };
    }
    case "strike":
      return { ...state, session: strike(s) };
    case "reel":
      return s.phase === "fighting"
        ? { ...state, session: { ...s, reeling: c.held } }
        : state;
    case "tick": {
      const next = tickSession(s, doc, Math.min(0.1, Math.max(0, c.dt)));
      if (next === s) return state;
      if (next.phase === "landed" && s.phase !== "landed") {
        // The catch enters the bag first; the ledger then records the same
        // fish under the same bag id, so a release can be matched to it.
        const landed = landCatch(doc, next, Date.now());
        return {
          ...state,
          doc: settlePending(landed, {
            source: "land",
            catchId: next.id,
            fish: next.fish,
            spot: next.spot,
            bait: next.bait,
          }),
          session: next,
        };
      }
      if (next.phase === "escaped" && s.phase !== "escaped") {
        return {
          ...state,
          doc: settlePending(
            {
              ...doc,
              stats: { ...doc.stats, escapes: doc.stats.escapes + 1 },
            },
            {
              source: "escape",
              catchId: null,
              fish: next.fish,
              spot: next.spot,
              bait: next.bait,
            },
          ),
          session: next,
        };
      }
      return { ...state, session: next };
    }
    case "next":
      return s.phase === "landed" || s.phase === "escaped"
        ? { ...state, doc: trimLedger(doc), session: idleSession() }
        : state;
    case "release": {
      const item = doc.bag.find((b) => b.id === c.id);
      if (!item) return state;
      const released = releaseCatch(doc, c.id);
      if (released === doc) return state;
      return {
        ...state,
        doc: record(released, {
          cast: released.cast,
          source: "release",
          catchId: item.id,
          fish: item.fish,
          spot: item.spot,
          bait: item.bait,
        }),
      };
    }
    case "claim":
      return busy ? state : { ...state, doc: claimPlan(doc, c.stage, c.id) };
    case "claim-all":
      return busy ? state : { ...state, doc: claimCombo(doc) };
    case "retry":
      return busy ? state : { ...state, doc: retryStage(doc, c.stage) };
    case "switch":
      return busy ? state : { ...state, doc: switchRoute(doc, c.stage) };
  }
}
