"""Refactor Target Ranker 파이프라인 오케스트레이션.

Step 0.1 스모크 기준으로 Conflict + Hub 차원만 지원. Staleness/Confusion/TermDrift는 후속.

흐름:
  1. 대상 시스템 선정 (hub 초벌 degree 상위 N)
  2. Stage 1+2 per 차원 (병렬 호출, Sonnet)
  3. Stage 3 scoring (공식, 정규화)
  4. Stage 4 Judge (Sonnet + rubric 캐시)
  5. Optional Self-Consistency (샘플 K회)
  6. refactor_targets.json + _perf 리포트 저장
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from . import conflict, corpus, hub, judge, scoring

PKG_ROOT = Path(__file__).resolve().parents[2]
DECISIONS_DIR = PKG_ROOT / "decisions"
HISTORY_DIR = DECISIONS_DIR / "_history"
PERF_DIR = DECISIONS_DIR / "_perf"


@dataclass
class RankerRun:
    dimensions: list[str]
    systems: list[str]
    started_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    stage_timings: dict[str, float] = field(default_factory=dict)
    stage_usage: dict[str, dict[str, int]] = field(default_factory=dict)


def _pick_systems(limit_systems: int) -> list[str]:
    return corpus.top_hub_systems(limit_systems)


def _aggregate_usage(meta_dict: dict[str, Any]) -> dict[str, int]:
    agg = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
    usage = meta_dict.get("usage") or {}
    for k in agg:
        agg[k] += int(usage.get(k, 0) or 0)
    return agg


def _sum_usage(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    return {k: a.get(k, 0) + b.get(k, 0) for k in set(a) | set(b)}


# ---- Stage runners -------------------------------------------------------

def _run_conflict(systems: list[str], *, concurrency: int, cov_model: str) -> tuple[dict[str, list[conflict.ConflictEvidence]], dict[str, dict[str, Any]], dict[str, int]]:
    print(f"\n[Stage 1+2 Conflict] systems={len(systems)}  concurrency={concurrency}")
    raw = conflict.collect_evidence(systems)
    verified: dict[str, list[conflict.ConflictEvidence]] = {s: [] for s in systems}
    meta_by_sys: dict[str, dict[str, Any]] = {}
    usage_total: dict[str, int] = {}

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        fut_map = {
            pool.submit(
                conflict.verify_evidence_for_system,
                s,
                raw[s],
                model=cov_model,
                thinking_budget=None,
                max_tokens=6000,
            ): s
            for s in systems
            if raw.get(s)
        }
        done_ct = 0
        for fut in as_completed(fut_map):
            s = fut_map[fut]
            try:
                ev, meta = fut.result()
            except Exception as e:
                print(f"  [ERR] conflict CoV {s}: {e}")
                verified[s] = []
                meta_by_sys[s] = {"error": str(e)}
                continue
            verified[s] = ev
            meta_by_sys[s] = meta
            usage_total = _sum_usage(usage_total, _aggregate_usage(meta))
            done_ct += 1
            kept = len(ev)
            total = len(raw[s])
            print(f"  [{done_ct}/{len(fut_map)}] {s}: kept={kept}/{total}")
    print(f"  conflict stage done in {time.time() - t0:.1f}s; usage={usage_total}")
    return verified, meta_by_sys, usage_total


def _run_hub(systems: list[str], *, concurrency: int, model: str) -> tuple[dict[str, hub.HubEvaluation], dict[str, dict[str, Any]], dict[str, int]]:
    print(f"\n[Stage 1+2 Hub] systems={len(systems)}  concurrency={concurrency}")
    evals = hub.collect_raw_edges(systems)
    meta_by_sys: dict[str, dict[str, Any]] = {}
    usage_total: dict[str, int] = {}

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        fut_map = {
            pool.submit(hub.classify_edges_for_system, evals[s], model=model, max_tokens=4000): s
            for s in systems
            if evals[s].raw_degree > 0
        }
        done_ct = 0
        for fut in as_completed(fut_map):
            s = fut_map[fut]
            try:
                ev, meta = fut.result()
            except Exception as e:
                print(f"  [ERR] hub classify {s}: {e}")
                meta_by_sys[s] = {"error": str(e)}
                continue
            evals[s] = ev
            meta_by_sys[s] = meta
            usage_total = _sum_usage(usage_total, _aggregate_usage(meta))
            done_ct += 1
            print(f"  [{done_ct}/{len(fut_map)}] {s}: weighted={ev.weighted_degree:.1f} (strong={ev.strong_count}, weak={ev.weak_count}, loose={ev.loose_count})")
    print(f"  hub stage done in {time.time() - t0:.1f}s; usage={usage_total}")
    return evals, meta_by_sys, usage_total


# ---- Main run ------------------------------------------------------------

def run(
    *,
    dimensions: list[str],
    limit_systems: int,
    cov_model: str = "sonnet",
    hub_model: str = "sonnet",
    judge_model: str = "sonnet",
    concurrency: int = 6,
    feedback_path: Path | None = None,
) -> dict[str, Any]:
    run_state = RankerRun(dimensions=dimensions, systems=[])
    overall_t0 = time.time()

    systems = _pick_systems(limit_systems)
    run_state.systems = systems
    print(f"Systems scope ({len(systems)}): {systems}")

    conflict_evidence: dict[str, list[conflict.ConflictEvidence]] = {s: [] for s in systems}
    hub_evals: dict[str, hub.HubEvaluation] = {}

    stage_meta: dict[str, Any] = {}

    if "conflict" in dimensions:
        t0 = time.time()
        conflict_evidence, c_meta, c_usage = _run_conflict(systems, concurrency=concurrency, cov_model=cov_model)
        run_state.stage_timings["conflict"] = round(time.time() - t0, 1)
        run_state.stage_usage["conflict"] = c_usage
        stage_meta["conflict"] = c_meta

    if "hub" in dimensions:
        t0 = time.time()
        hub_evals, h_meta, h_usage = _run_hub(systems, concurrency=concurrency, model=hub_model)
        run_state.stage_timings["hub"] = round(time.time() - t0, 1)
        run_state.stage_usage["hub"] = h_usage
        stage_meta["hub"] = h_meta

    # Stage 3: scoring
    print("\n[Stage 3] scoring (결정론적 공식)")
    dim_raw: dict[str, dict[str, float]] = {s: {} for s in systems}
    dim_facts_conflict: dict[str, Any] = {}
    dim_facts_hub: dict[str, Any] = {}

    for s in systems:
        if "conflict" in dimensions:
            raw_val, facts = scoring.conflict_raw(conflict_evidence.get(s, []))
            dim_raw[s]["conflict"] = raw_val
            dim_facts_conflict[s] = facts
        if "hub" in dimensions:
            if s in hub_evals:
                raw_val, facts = scoring.hub_raw(hub_evals[s])
            else:
                raw_val, facts = 0.0, {"raw_degree": 0}
            dim_raw[s]["hub"] = raw_val
            dim_facts_hub[s] = facts

    # normalize per dim
    dim_scores: dict[str, dict[str, scoring.DimensionScore]] = {s: {} for s in systems}
    for dim in dimensions:
        raw_by_sys = {s: dim_raw[s].get(dim, 0.0) for s in systems}
        normalized = scoring.normalize(raw_by_sys)
        for s in systems:
            if dim == "conflict":
                facts = dim_facts_conflict.get(s, {})
            elif dim == "hub":
                facts = dim_facts_hub.get(s, {})
            else:
                facts = {}
            dim_scores[s][dim] = scoring.DimensionScore(
                value=normalized[s], raw=raw_by_sys[s], facts=facts
            )

    for s in systems:
        dim_summary = "  ".join(f"{d}={dim_scores[s][d].value:4.1f}" for d in dimensions)
        print(f"  {dim_summary}  {s}")

    # Stage 4 Judge
    print("\n[Stage 4] Judge (Sonnet + rubric cache)")
    evidence_samples: dict[str, list[dict[str, Any]]] = {}
    for s in systems:
        samples: list[dict[str, Any]] = []
        for ev in conflict_evidence.get(s, [])[:3]:
            samples.append(
                {
                    "dimension": "conflict",
                    "topic": ev.topic,
                    "cited_text": ev.cited_text,
                    "confidence": ev.confidence,
                    "verdict": ev.verdict,
                }
            )
        evidence_samples[s] = samples

    # flat dim_scores for judge input (DimensionScore -> dict)
    judge_input_scores = {
        s: {d: dim_scores[s][d] for d in dimensions} for s in systems
    }

    feedback_few_shots: list[dict[str, Any]] = []
    if feedback_path and feedback_path.exists():
        for line in feedback_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    feedback_few_shots.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    t0 = time.time()
    try:
        # N systems에 비례하게 max_tokens 산정: 시스템당 ~300 tokens + 여유
        judge_max_tokens = max(4000, len(systems) * 350 + 2000)
        ranking, judge_meta = judge.rank(
            judge_input_scores,
            conflict_facts=dim_facts_conflict,
            hub_facts=dim_facts_hub,
            evidence_samples=evidence_samples,
            feedback_few_shots=feedback_few_shots,
            model=judge_model,
            max_tokens=judge_max_tokens,
        )
        if judge_meta.get("stop_reason") == "max_tokens":
            print(
                f"  [warn] Judge output truncated (stop_reason=max_tokens). "
                f"Increase max_tokens beyond {judge_max_tokens}."
            )
    except Exception as e:
        print(f"  [ERR] judge failed: {e}")
        ranking = []
        judge_meta = {"error": str(e)}
    run_state.stage_timings["judge"] = round(time.time() - t0, 1)
    run_state.stage_usage["judge"] = _aggregate_usage(judge_meta)

    # 결과 패키징
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    PERF_DIR.mkdir(parents=True, exist_ok=True)

    targets = []
    for rank_idx, r in enumerate(ranking, 1):
        name = r.get("name")
        ds = dim_scores.get(name, {})
        conf_ev = conflict_evidence.get(name, [])
        evid_out: list[dict[str, Any]] = []
        for ev in conf_ev[:6]:
            evid_out.append(
                {
                    "dimension": "conflict",
                    "cited_text": ev.cited_text,
                    "source": ev.source,
                    "reason": ev.reason,
                    "confidence": ev.confidence,
                    "verified_by_cov": ev.verified_by_cov,
                }
            )
        he = hub_evals.get(name)
        if he:
            for e in [e for e in he.edges if e.strength == "strong"][:3]:
                evid_out.append(
                    {
                        "dimension": "hub",
                        "cited_text": f"{name} ↔ {e.target}",
                        "source": {"kind": "graph_edge", "target": e.target},
                        "reason": e.reason,
                        "confidence": "high",
                        "verified_by_cov": True,
                    }
                )

        targets.append(
            {
                "rank": rank_idx,
                "name": name,
                "grade": r.get("grade"),
                "rationale": r.get("rationale"),
                "dimension_scores": {
                    d: {
                        "value": ds[d].value,
                        "raw": ds[d].raw,
                        "facts": ds[d].facts,
                    }
                    for d in ds
                },
                "evidence": evid_out,
                "blast_radius_note": r.get("blast_radius_note"),
                "effort": r.get("effort"),
                "confidence_flags": r.get("confidence_flags", []),
            }
        )

    report = {
        "generated_at": run_state.started_at,
        "ranker_version": "0.1.0-step0.1",
        "dimensions_used": dimensions,
        "systems_scope": {
            "total": len(corpus.all_systems()),
            "limited_to": len(systems),
            "selection_rule": f"hub_degree_top_{limit_systems}",
        },
        "targets": targets,
    }

    latest = DECISIONS_DIR / "refactor_targets.json"
    latest.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    archive = HISTORY_DIR / f"refactor_targets_{int(time.time())}.json"
    archive.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    perf_path = PERF_DIR / f"ranker_run_{int(time.time())}.json"
    perf_path.write_text(
        json.dumps(
            {
                "started_at": run_state.started_at,
                "dimensions": dimensions,
                "systems": systems,
                "stage_timings": run_state.stage_timings,
                "stage_usage": run_state.stage_usage,
                "total_elapsed_s": round(time.time() - overall_t0, 1),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"\n[✓] refactor_targets.json written ({len(targets)} targets)")
    print(f"[✓] perf log: {perf_path.name}")
    print(f"[✓] total: {time.time() - overall_t0:.1f}s")
    return report
