export type SpotId = "reed" | "brook" | "deep";
export type BaitId = "worm" | "corn" | "fly";
export type FishId = "crucian" | "perch" | "carp" | "trout" | "bass" | "pike";
export type Phase =
  "ready" | "charging" | "waiting" | "bite" | "fighting" | "landed" | "escaped";
export interface FishSpecies {
  id: FishId;
  name: string;
  latin: string;
  color: string;
  rarity: string;
  min: number;
  max: number;
  strength: number;
  waters: SpotId[];
  baits: BaitId[];
  note: string;
}
export interface Catch {
  id: string;
  fish: FishId;
  weight: number;
  spot: SpotId;
  bait: BaitId;
  time: number;
  duration: number;
  peakTension: number;
}
export interface JournalEntry {
  count: number;
  best: number;
  first: number;
}

/**
 * One ordered act in the long journal. Every way a cast can end — landed,
 * released, escaped, interrupted by refresh/disconnect, a stage retried or a
 * contract switched — appends exactly one event with the next `seq`.
 * Nothing here is ever renumbered or re-ordered.
 */
export type TripSource =
  | "land"
  | "release"
  | "escape"
  | "aborted"
  | "retry"
  | "switch";
export interface TripEvent {
  /** Monotonic across the whole document; the only ordering that counts. */
  seq: number;
  /** Cast number the act belongs to; budgets are measured in casts. */
  cast: number;
  source: TripSource;
  /** Bag id for a landed/released fish; null for escapes and interruptions. */
  catchId: string | null;
  fish: FishId | null;
  spot: SpotId;
  bait: BaitId;
}
/** Small immutable witness kept inside windows, failures and claims. */
export interface WatchedAttempt {
  seq: number;
  cast: number;
  fish: FishId;
  spot: SpotId;
  bait: BaitId;
  source: TripSource;
  catchId: string | null;
}
/** A frozen, complete proof that one route was satisfied. */
export interface Evidence {
  plan: string;
  seqs: number[];
  catchIds: string[];
  witnesses: WatchedAttempt[];
  startCast: number;
  lastCast: number;
}
/** A window that can still be completed if the right fish comes in time. */
export interface WindowPreview {
  plan: string;
  label: string;
  startSeq: number;
  startCast: number;
  witnesses: WatchedAttempt[];
  matched: number;
  total: number;
  /** Casts left inside the stage budget from the current cast. */
  remainingCasts: number;
  /** Human-readable next step and deadline. */
  text: string;
}
export interface FailureRecord {
  attempt: number;
  atSeq: number;
  atCast: number;
  reason: string;
  witnesses: WatchedAttempt[];
}
export interface ClaimRecord {
  stage: string;
  plan: string;
  reward: string;
  seqs: number[];
  catchIds: string[];
  witnesses: WatchedAttempt[];
  atSeq: number;
  at: number;
}
/** Everything a single stage remembers, always bounded. */
export interface StageState {
  /** First event seq this attempt may use; stamped when the stage opens. */
  openedSeq: number | null;
  /** Cast count at opening; only later casts fall inside the budget. */
  openedCast: number | null;
  attempts: number;
  claimed: ClaimRecord | null;
  abandoned: boolean;
  abandonedReason: string | null;
  expired: boolean;
  expiredAtCast: number | null;
  /** Complete windows kept for display (at most one per route + alternates). */
  offers: Evidence[];
  /** Still-completable partial windows kept for display. */
  windows: WindowPreview[];
  /** Failure explanations with witness events, bounded. */
  failures: FailureRecord[];
  failuresDropped: number;
  /** Recent process witnesses kept even after raw events are compressed. */
  trace: WatchedAttempt[];
  traceDropped: number;
}
export interface LedgerTrim {
  throughSeq: number;
  dropped: number;
  kept: number;
  at: number;
}
export interface JournalLedger {
  events: TripEvent[];
  trim: LedgerTrim | null;
  stages: Record<string, StageState>;
}
/** A cast in flight, persisted so refresh/disconnect advances the order once. */
export interface PendingCast {
  cast: number;
  catchId: string | null;
  fish: FishId | null;
  spot: SpotId;
  bait: BaitId;
}
export interface GameDocument {
  /** 2 adds the contract ledger; version 1 documents are migrated on load. */
  version: 2;
  spot: SpotId;
  bait: BaitId;
  power: number;
  drag: number;
  seed: number;
  stock: Record<BaitId, number>;
  bag: Catch[];
  journal: Partial<Record<FishId, JournalEntry>>;
  stats: { casts: number; catches: number; escapes: number; released: number };
  /** Rewarded route ids; the authoritative record is StageState.claimed. */
  claimed: string[];
  /** Next event seq to assign; never rewinds. */
  seq: number;
  /** Casts started; every stage budget is measured in these. */
  cast: number;
  pending: PendingCast | null;
  ledger: JournalLedger;
  /** One-shot explanations for refusals, shown in the notice toast. */
  notes: string[];
}
export interface Session {
  id: string;
  phase: Phase;
  clock: number;
  charge: number;
  castPower: number;
  spot: SpotId;
  bait: BaitId;
  fish: FishId | null;
  weight: number;
  biteAt: number;
  progress: number;
  tension: number;
  energy: number;
  slackTime: number;
  overload: number;
  peak: number;
  reeling: boolean;
  duration: number;
  message: string;
}
export interface Workspace {
  doc: GameDocument;
  session: Session;
  notice: string;
}
