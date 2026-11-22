import { useState } from "react";
import {
  Flag,
  Check,
  ChevronDown,
  Lock,
  RotateCcw,
  Shuffle,
  GitBranch,
  Layers,
  AlertTriangle,
  CircleDot,
} from "lucide-react";
import type { Command } from "../../../shared/commands";
import type { GameDocument, StageState, WindowPreview } from "../../../shared/types";
import { analyzeAll, settle, type StageAnalysis } from "../lib/match";

function witnessChips(w: { seq: number; fish: string }[]) {
  return w.map((x) => `#${x.seq}`).join(" ");
}

export function ChallengePanel({
  doc,
  send,
}: {
  doc: GameDocument;
  send: (c: Command) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const analyses = analyzeAll(doc);
  const settlement = settle(doc);
  const shown = expanded ? analyses : analyses.slice(0, 2);
  const claimedCount = analyses.filter((a) => a.status === "claimed").length;
  return (
    <section className="challenge-panel">
      <div className="section-title">
        <Flag size={16} />
        <h2>钓手契约</h2>
        <span className="contract-count">{claimedCount} 份已领</span>
        <button
          className="text-btn"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : "全部"}
          <ChevronDown size={13} />
        </button>
      </div>

      {settlement.combo.length > 1 && (
        <div className="contract-combo" role="status">
          <Layers size={14} />
          <span>
            可同时领取 {settlement.combo.length} 份：
            {settlement.combo
              .map((id) => analyses.find((a) => a.stage.id === id)?.stage.name)
              .filter(Boolean)
              .join("、")}
          </span>
          <button
            className="claim-btn"
            onClick={() => send({ type: "claim-all" })}
          >
            一并领取
          </button>
        </div>
      )}

      <div className="challenge-list">
        {shown.map((a) => (
          <StageCard
            key={a.stage.id}
            a={a}
            doc={doc}
            send={send}
            combo={settlement.combo.includes(a.stage.id)}
            conflict={settlement.conflicts[a.stage.id]}
          />
        ))}
      </div>
      <p className="contract-foot">
        开约前的收获不补算；同一尾鱼可被多份契约预览，正式结算只归一个阶段。
      </p>
    </section>
  );
}

function StageCard({
  a,
  doc,
  send,
  combo,
  conflict,
}: {
  a: StageAnalysis;
  doc: GameDocument;
  send: (c: Command) => void;
  combo: boolean;
  conflict?: string;
}) {
  const [open, setOpen] = useState(false);
  const { stage, state, status } = a;
  const done = status === "claimed";
  const showWindows = open;
  return (
    <div className={"contract-item status-" + status}>
      <button
        className="contract-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={"challenge-stamp " + (done ? "done" : "")}>
          <Flag size={17} />
        </span>
        <span>
          <strong>{stage.name}</strong>
          <small>
            {status === "locked"
              ? a.lock
              : status === "claimed"
                ? `已领取 · ${state.claimed?.reward}`
                : status === "abandoned"
                  ? `已放弃 · ${state.abandonedReason}`
                  : status === "expired"
                    ? `预算用尽 · 可重试`
                    : `${a.windows.length} 个可完成窗口 · 预算 ${stage.budget.casts} 竿`}
          </small>
        </span>
        {status === "locked" ? (
          <Lock size={13} aria-label="契约未解锁" />
        ) : done ? (
          <Check size={16} />
        ) : status === "active" ? (
          <span className="challenge-count">
            余{" "}
            {Math.max(
              0,
              stage.budget.casts -
                (doc.cast - (state.openedCast ?? doc.cast)),
            )}{" "}
            竿
          </span>
        ) : null}
      </button>

      {open && (
        <div className="contract-body">
          <p className="contract-brief">{stage.brief}</p>
          <RouteRows a={a} send={send} />
          <WindowList windows={a.windows} show={showWindows} />
          {combo && <span className="combo-mark">可与其他阶段同时领取</span>}
          {conflict && <span className="conflict-mark">{conflict}</span>}
          <StageFooter a={a} send={send} />
          <FailureList state={state} />
        </div>
      )}
    </div>
  );
}

function RouteRows({
  a,
  send,
}: {
  a: StageAnalysis;
  send: (c: Command) => void;
}) {
  const { stage, state, status, routes } = a;
  return (
    <div className="route-list">
      <div className="route-legend">
        <GitBranch size={12} />
        {stage.routes.length > 1 ? "任选一组，提交一条后互斥" : "单一路线"}
      </div>
      {stage.routes.map((route) => {
        const analysis = routes.find((r) => r.route.id === route.id);
        const complete = analysis?.complete.length ?? 0;
        const live = analysis?.live[0] ?? null;
        const claimedHere = state.claimed?.plan === route.id;
        return (
          <div
            className={
              "route-row" +
              (complete > 0 ? " ready" : "") +
              (claimedHere ? " claimed" : "")
            }
            key={route.id}
          >
            <div>
              <strong>{route.label}</strong>
              <small>奖励 · {route.reward}</small>
              <ol className="route-steps">
                {route.steps.map((step, i) => (
                  <li key={i}>
                    {step.action === "catch" ? "捕获" : "放流"}
                    {fishStepName(step.fish)} · {baitStepName(step.bait)}
                    {step.spot ? ` · ${spotStepName(step.spot)}` : ""} ·{" "}
                    {step.span} 竿
                  </li>
                ))}
              </ol>
              {live && !claimedHere && (
                <em>
                  {live.matched}/{route.steps.length} 步 · 见证{" "}
                  {witnessChips(live.witnesses)}
                </em>
              )}
            </div>
            {status === "active" &&
              (complete > 0 ? (
                <button
                  className="claim-btn"
                  onClick={() => send({ type: "claim", stage: stage.id, id: route.id })}
                >
                  提交
                </button>
              ) : (
                <span className="challenge-count">
                  {analysis?.live[0]?.matched ?? 0}/{route.steps.length}
                </span>
              ))}
            {claimedHere && <Check size={15} />}
          </div>
        );
      })}
      {status === "abandoned" && (
        <small className="abandoned-note">
          <AlertTriangle size={11} /> {state.abandonedReason}
        </small>
      )}
    </div>
  );
}

function WindowList({
  windows,
  show,
}: {
  windows: WindowPreview[];
  show: boolean;
}) {
  if (!show || windows.length === 0) return null;
  return (
    <div className="window-list">
      <span className="window-title">
        <CircleDot size={11} /> 仍可完成的窗口
      </span>
      {windows.map((w, i) => (
        <div className="window-row" key={`${w.plan}-${w.startSeq}-${i}`}>
          <span>
            {w.label} · {w.matched}/{w.total} 步
          </span>
          <small>{w.text}</small>
          <em>见证 {witnessChips(w.witnesses)}</em>
        </div>
      ))}
    </div>
  );
}

function StageFooter({
  a,
  send,
}: {
  a: StageAnalysis;
  send: (c: Command) => void;
}) {
  const { stage, status } = a;
  if (!["active", "expired"].includes(status)) return null;
  return (
    <div className="contract-actions">
      <button
        className="text-btn"
        onClick={() => send({ type: "retry", stage: stage.id })}
      >
        <RotateCcw size={12} /> 重试本阶段
      </button>
      {stage.routes.length > 1 && (
        <button
          className="text-btn"
          onClick={() => send({ type: "switch", stage: stage.id })}
        >
          <Shuffle size={12} /> 换约
        </button>
      )}
    </div>
  );
}

function FailureList({ state }: { state: StageState }) {
  if (state.failures.length === 0) return null;
  return (
    <div className="failure-list">
      <span className="window-title">
        <AlertTriangle size={11} /> 过程记录
      </span>
      {state.failures.map((f, i) => (
        <div className="failure-row" key={`${f.atSeq}-${i}`}>
          <small>{f.reason}</small>
          {f.witnesses.length > 0 && (
            <em>见证 {witnessChips(f.witnesses)}</em>
          )}
        </div>
      ))}
      {state.failuresDropped > 0 && (
        <small className="muted">
          已压缩 {state.failuresDropped} 条较早记录，原因与见证保留在对应阶段。
        </small>
      )}
    </div>
  );
}

/* Tiny local label helpers keep this file free of catalog imports. */
function fishStepName(id: string) {
  return (
    ({
      crucian: "银鲫",
      perch: "河鲈",
      carp: "锦鲤",
      trout: "虹鳟",
      bass: "大口黑鲈",
      pike: "白斑狗鱼",
    } as Record<string, string>)[id] ?? id
  );
}
function baitStepName(id: string) {
  return ({ worm: "蚯蚓", corn: "玉米", fly: "拟蝇" } as Record<string, string>)[
    id
  ] ?? id;
}
function spotStepName(id: string) {
  return (
    ({ reed: "芦苇浅湾", brook: "青石溪流", deep: "镜湖深水" } as Record<
      string,
      string
    >)[id] ?? id
  );
}
