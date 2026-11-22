import { newDocument } from "../shared/initial";
import { fishCatalog } from "../shared/catalog";
import type { GameDocument } from "../shared/types";
import { contractStages } from "../features/challenges/model/contracts";
import { emptyStage } from "../features/challenges/lib/match";

const key = "stillwater-jdk024-v2";
const legacyKey = "stillwater-jdk024-v1";

const fishIds = fishCatalog.map((f) => f.id);
const spots = ["reed", "brook", "deep"];
const baits = ["worm", "corn", "fly"];

function validLedger(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const l = value as GameDocument["ledger"];
  return (
    Array.isArray(l.events) &&
    l.events.every(
      (e) =>
        e &&
        Number.isInteger(e.seq) &&
        e.seq >= 0 &&
        Number.isInteger(e.cast) &&
        e.cast >= 0 &&
        ["land", "release", "escape", "aborted", "retry", "switch"].includes(
          e.source,
        ) &&
        (e.catchId === null || typeof e.catchId === "string") &&
        (e.fish === null || fishIds.includes(e.fish)) &&
        spots.includes(e.spot) &&
        baits.includes(e.bait),
    ) &&
    !!l.stages &&
    Object.entries(l.stages).every(([id, st]) => {
      if (!contractStages.some((s) => s.id === id)) return false;
      return (
        st &&
        (st.openedSeq === null || Number.isInteger(st.openedSeq)) &&
        (st.openedCast === null || Number.isInteger(st.openedCast)) &&
        Number.isInteger(st.attempts) &&
        Array.isArray(st.offers) &&
        Array.isArray(st.windows) &&
        Array.isArray(st.failures) &&
        Array.isArray(st.trace) &&
        (st.claimed === null ||
          (typeof st.claimed === "object" &&
            Array.isArray(st.claimed.seqs)))
      );
    })
  );
}

function valid(value: unknown): value is GameDocument {
  if (!value || typeof value !== "object") return false;
  const d = value as GameDocument;
  return (
    d.version === 2 &&
    spots.includes(d.spot) &&
    baits.includes(d.bait) &&
    Number.isFinite(d.power) &&
    d.power >= 0.15 &&
    d.power <= 0.95 &&
    Number.isFinite(d.drag) &&
    d.drag >= 0.15 &&
    d.drag <= 0.95 &&
    Number.isInteger(d.seed) &&
    !!d.stock &&
    baits.every(
      (b) =>
        Number.isInteger(d.stock[b as keyof typeof d.stock]) &&
        d.stock[b as keyof typeof d.stock] >= 0,
    ) &&
    !!d.stats &&
    ["casts", "catches", "escapes", "released"].every(
      (k) =>
        Number.isInteger(d.stats[k as keyof typeof d.stats]) &&
        d.stats[k as keyof typeof d.stats] >= 0,
    ) &&
    Array.isArray(d.claimed) &&
    d.claimed.every((c) => typeof c === "string") &&
    Array.isArray(d.bag) &&
    d.bag.every(
      (c) =>
        c &&
        typeof c.id === "string" &&
        fishIds.includes(c.fish) &&
        spots.includes(c.spot) &&
        baits.includes(c.bait) &&
        [c.weight, c.time, c.duration, c.peakTension].every(Number.isFinite),
    ) &&
    !!d.journal &&
    Object.entries(d.journal).every(
      ([id, e]) =>
        fishIds.includes(id as (typeof fishIds)[number]) &&
        e &&
        Number.isInteger(e.count) &&
        e.count > 0 &&
        Number.isFinite(e.best) &&
        Number.isFinite(e.first),
    ) &&
    Number.isInteger(d.seq) &&
    d.seq >= 0 &&
    Number.isInteger(d.cast) &&
    d.cast >= 0 &&
    (d.pending === null ||
      (typeof d.pending === "object" && Number.isInteger(d.pending.cast))) &&
    validLedger(d.ledger) &&
    Array.isArray(d.notes)
  );
}

/**
 * v1 stored only cumulative counters, so its history cannot be reconstructed.
 * Migration therefore starts the ledger at a clean boundary: earlier catches
 * can still unlock nothing already earned, and nothing is back-filled.
 */
function migrateLegacy(value: unknown): GameDocument | null {
  if (!value || typeof value !== "object") return null;
  const old = value as Record<string, unknown>;
  if (old.version !== 1) return null;
  const base = newDocument();
  const stageStates = Object.fromEntries(
    contractStages.map((s) => [s.id, emptyStage()]),
  );
  return {
    ...base,
    spot: spots.includes(old.spot as string)
      ? (old.spot as GameDocument["spot"])
      : base.spot,
    bait: baits.includes(old.bait as string)
      ? (old.bait as GameDocument["bait"])
      : base.bait,
    seed: Number.isInteger(old.seed) ? (old.seed as number) : base.seed,
    stock:
      old.stock && typeof old.stock === "object"
        ? { ...base.stock, ...(old.stock as GameDocument["stock"]) }
        : base.stock,
    bag: Array.isArray(old.bag) ? (old.bag as GameDocument["bag"]) : [],
    journal:
      old.journal && typeof old.journal === "object"
        ? (old.journal as GameDocument["journal"])
        : {},
    stats:
      old.stats && typeof old.stats === "object"
        ? { ...base.stats, ...(old.stats as GameDocument["stats"]) }
        : base.stats,
    claimed: [],
    cast: 0,
    seq: 0,
    ledger: { events: [], trim: null, stages: stageStates },
  };
}

export function loadGame(): {
  doc: GameDocument;
  notice: string;
  recovery?: true;
} {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy) {
        const migrated = migrateLegacy(JSON.parse(legacy));
        if (migrated) {
          return {
            doc: migrated,
            notice:
              "旧版手记已升级：累计收获与图鉴保留，契约从升级这一刻重新开始计时。",
          };
        }
      }
      return { doc: newDocument(), notice: "" };
    }
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed)
      ? { doc: parsed, notice: "" }
      : {
          doc: newDocument(),
          notice: "本地手记格式或版本无法读取，已保留原手记并开启临时游玩。",
          recovery: true,
        };
  } catch {
    return {
      doc: newDocument(),
      notice: "无法读取本地手记，已暂停自动保存，本次可以临时游玩。",
      recovery: true,
    };
  }
}
export function saveGame(doc: GameDocument) {
  try {
    localStorage.setItem(key, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}
