import { species } from "../../../shared/catalog";
import type { BaitId, FishId, SpotId, TripEvent } from "../../../shared/types";

/**
 * 钓手契约
 *
 * 一个阶段 = 若干互斥组（route）。每次尝试只能提交其中一组；组内步骤
 * 按事件顺序完成，每一步要求「用指定饵捕获或放流指定鱼种」，相邻两步必须
 * 落在允许的连续竿数（span）内。整组还必须在阶段打开后的 castBudget 竿内
 * 完成；阶段打开之前的事件一律不补算。
 */

export type StepAction = "catch" | "release";

export interface ContractStep {
  action: StepAction;
  fish: FishId;
  bait: BaitId;
  /** 距上一步（第一步为开约当竿）最多再过几竿，本步必须落地。 */
  span: number;
  spot?: SpotId;
  /**
   * 放流步骤是否必须放回本组前面捕获的那一尾（默认 true）。
   * 关闭时可放流背包里任意同种同饵的鱼。
   */
  sameFish?: boolean;
}

export interface ContractRoute {
  id: string;
  label: string;
  reward: string;
  steps: ContractStep[];
}

export interface ContractStage {
  id: string;
  name: string;
  brief: string;
  /** 前置阶段：全部领奖后才打开。 */
  requires: string[];
  /** 任一前置领奖即可打开（用于互斥路线之后的下游）。 */
  requiresAny?: string[];
  /** 互斥路线：提交其中一条后，另一条未领奖阶段放弃。 */
  rivalsWith: string[];
  budget: { casts: number };
  routes: ContractRoute[];
}

export const contractStages: ContractStage[] = [
  {
    id: "wake",
    name: "初醒的浮漂",
    brief: "在芦苇浅湾用蚯蚓捕获银鲫，再接一尾河鲈；或捕获后把同一尾银鲫放回水里。",
    requires: [],
    rivalsWith: [],
    budget: { casts: 7 },
    routes: [
      {
        id: "wake-a",
        label: "芦苇的早晨",
        reward: "启程徽章",
        steps: [
          { action: "catch", fish: "crucian", bait: "worm", span: 3, spot: "reed" },
          { action: "catch", fish: "perch", bait: "worm", span: 3, spot: "reed" },
        ],
      },
      {
        id: "wake-b",
        label: "只留一尾",
        reward: "启程徽章",
        steps: [
          { action: "catch", fish: "crucian", bait: "worm", span: 4, spot: "reed" },
          { action: "release", fish: "crucian", bait: "worm", span: 4, spot: "reed" },
        ],
      },
    ],
  },
  {
    id: "brook",
    name: "溪流的来信",
    brief: "去青石溪流：用拟蝇直接捕获虹鳟，或用活饵捕获后再放流同一尾。",
    requires: ["wake"],
    rivalsWith: ["deep"],
    budget: { casts: 9 },
    routes: [
      {
        id: "brook-a",
        label: "拟蝇的弧线",
        reward: "青石溪流",
        steps: [
          { action: "catch", fish: "trout", bait: "fly", span: 5, spot: "brook" },
        ],
      },
      {
        id: "brook-b",
        label: "活饵的耐心",
        reward: "青石溪流",
        steps: [
          { action: "catch", fish: "trout", bait: "worm", span: 4, spot: "brook" },
          { action: "release", fish: "trout", bait: "worm", span: 4, spot: "brook" },
        ],
      },
    ],
  },
  {
    id: "deep",
    name: "镜湖深处",
    brief: "去镜湖深水用拟蝇：捕获大口黑鲈，或捕获白斑狗鱼后放流同一尾。",
    requires: ["wake"],
    rivalsWith: ["brook"],
    budget: { casts: 10 },
    routes: [
      {
        id: "deep-a",
        label: "黑鲈的领地",
        reward: "镜湖深水",
        steps: [
          { action: "catch", fish: "bass", bait: "fly", span: 6, spot: "deep" },
        ],
      },
      {
        id: "deep-b",
        label: "狗鱼的呼吸",
        reward: "镜湖深水",
        steps: [
          { action: "catch", fish: "pike", bait: "fly", span: 6, spot: "deep" },
          { action: "release", fish: "pike", bait: "fly", span: 5, spot: "deep" },
        ],
      },
    ],
  },
  {
    id: "corn",
    name: "玉米的甜味",
    brief: "在芦苇浅湾用玉米捕获锦鲤。可与「观鲈」同时准备，但同一尾鱼只归一个阶段。",
    requires: [],
    rivalsWith: [],
    budget: { casts: 8 },
    routes: [
      {
        id: "corn-a",
        label: "锦鲤的午后",
        reward: "玉米秘方",
        steps: [
          { action: "catch", fish: "carp", bait: "corn", span: 6, spot: "reed" },
        ],
      },
    ],
  },
  {
    id: "watch",
    name: "水边的观鲈",
    brief: "在芦苇浅湾用拟蝇捕获河鲈，再在同一段连竿里放流它。与「玉米的甜味」并行。",
    requires: [],
    rivalsWith: [],
    budget: { casts: 8 },
    routes: [
      {
        id: "watch-a",
        label: "树影里的鲈",
        reward: "观鲈手记",
        steps: [
          { action: "catch", fish: "perch", bait: "fly", span: 6, spot: "reed" },
          { action: "release", fish: "perch", bait: "fly", span: 4, spot: "reed" },
        ],
      },
    ],
  },
  {
    id: "keeper",
    name: "把相遇留在水里",
    brief: "用玉米捕获银鲫，再把同一尾放流。溪流或深水任一路线领奖后打开。",
    requires: [],
    requiresAny: ["brook", "deep"],
    rivalsWith: [],
    budget: { casts: 8 },
    routes: [
      {
        id: "keeper-a",
        label: "鲫鱼的回访",
        reward: "护水徽章",
        steps: [
          { action: "catch", fish: "crucian", bait: "corn", span: 5 },
          { action: "release", fish: "crucian", bait: "corn", span: 4 },
        ],
      },
    ],
  },
];

export function stageById(id: string) {
  return contractStages.find((s) => s.id === id) ?? null;
}

export function routeById(stage: ContractStage, id: string) {
  return stage.routes.find((r) => r.id === id) ?? null;
}

export function fishName(id: FishId) {
  return species(id).name;
}

export function baitName(id: BaitId) {
  return id === "worm" ? "蚯蚓" : id === "corn" ? "玉米" : "拟蝇";
}

export function spotName(id: SpotId) {
  return id === "reed" ? "芦苇浅湾" : id === "brook" ? "青石溪流" : "镜湖深水";
}

export function stepText(step: ContractStep) {
  return (
    `${step.action === "catch" ? "捕获" : "放流"}${fishName(step.fish)}` +
    `（${baitName(step.bait)}${step.spot ? ` · ${spotName(step.spot)}` : ""} · ${step.span} 竿内）`
  );
}

export function routeText(route: ContractRoute) {
  return route.steps.map(stepText).join(" → ");
}

export type StepMatch =
  | "ok"
  | "wrong-fish"
  | "wrong-bait"
  | "wrong-spot"
  | "wrong-action"
  | "wrong-fish-id";

/** Pure predicate: does one event satisfy the step's shape (ignoring order)? */
export function matchStep(
  step: ContractStep,
  e: TripEvent,
  expectCatchId: string | null,
): StepMatch {
  if (!e.fish || e.fish !== step.fish) return "wrong-fish";
  if (e.bait !== step.bait) return "wrong-bait";
  if (step.spot && e.spot !== step.spot) return "wrong-spot";
  if (step.action === "catch" && e.source !== "land") return "wrong-action";
  if (step.action === "release" && e.source !== "release")
    return "wrong-action";
  if (
    step.action === "release" &&
    step.sameFish !== false &&
    expectCatchId !== null &&
    e.catchId !== expectCatchId
  )
    return "wrong-fish-id";
  return "ok";
}

/**
 * Cast-distance rule.
 *
 * For the first step (`prevCast === null`) the only bound is the stage budget:
 * any later event may *open* a fresh window. This is deliberate — a window
 * whose head died must not prevent a tail event from becoming the next
 * attempt's beginning, and after a retry the new opening boundary is the only
 * thing that resets history.
 *
 * For later steps, `span` bounds the gap since the previous consumed cast. A
 * release may share its catch's cast; a catch needs a strictly later cast than
 * the previous catch because one cast lands at most one fish.
 */
export function withinSpan(
  step: ContractStep,
  e: TripEvent,
  prevCast: number | null,
  openedCast: number,
  budget: number,
) {
  if (e.cast - openedCast > budget) return false;
  if (e.cast < openedCast) return false;
  if (prevCast === null) return true;
  const gap = e.cast - prevCast;
  if (gap < 0) return false;
  if (gap > step.span) return false;
  if (step.action === "catch" && gap < 1) return false;
  return true;
}
