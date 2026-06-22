"""
Bear / Base / Bull 12-month price scenarios — now expressed as RANGES with
plain-English, theme-aware rationales (instead of single point prices and
analytical bullets like "1-σ downside from annualized volatility").

Each scenario blends three anchors so no single source dominates:
  • Technical:   ATR-derived expected drift
  • Fundamental: DCF intrinsic value
  • Consensus:   Analyst targets (low / mean / high)

The midpoint is the weighted blend; the range is built around it using the
stock's own volatility so high-beta names get wider bands than mega-caps.
"""
from __future__ import annotations

import math
from typing import Optional


# Trading days in a year — used to annualize daily ATR drift.
TRADING_DAYS = 252


# Theme-aware rationales — when a ticker is tagged with a theme, the scenario
# narrative borrows that theme's dominant bull/bear narrative. Keeps the brief
# from sounding generic ("multiple compression") and instead reads like a PM
# memo ("AI spending slows").
THEME_RATIONALES: dict[str, dict[str, str]] = {
    "ai-infra": {
        "bear": "AI capex slows or hyperscaler buildout pauses.",
        "base": "Execution remains solid and hyperscaler contracts convert into revenue.",
        "bull": "Market re-rates {ticker} as a premium AI-infrastructure platform.",
    },
    "data-centers": {
        "bear": "Power constraints or capex cycle slows the data-center build-out.",
        "base": "Steady contracted capacity additions, occupancy holds.",
        "bull": "AI-driven hyperscale demand triggers a multi-year build supercycle.",
    },
    "semis": {
        "bear": "Inventory correction or foundry utilization slips.",
        "base": "Node transitions execute cleanly, ASPs hold.",
        "bull": "Sustained pricing power on advanced nodes, AI demand stays hot.",
    },
    "space": {
        "bear": "Launch failure or program slip wipes out a quarter of progress.",
        "base": "Steady launch cadence and contract bookings on plan.",
        "bull": "Sat-comms commercialization or mega-constellation execution surprises.",
    },
    "defense": {
        "bear": "Continuing resolution or budget cuts drag the spending cycle.",
        "base": "DoD budget grows in line with the FY plan, awards convert on schedule.",
        "bull": "Supplemental aid and foreign military sales surge above plan.",
    },
    "energy-transition": {
        "bear": "Power-demand revisions lower or cost overruns hit key projects.",
        "base": "Steady demand growth from data centers and electrification.",
        "bull": "SMR licensing accelerates or data-center PPAs re-rate the group.",
    },
    "quantum": {
        "bear": "Hype cycle deflates, milestones miss, dilution intensifies.",
        "base": "Slow technical progress, no clear winner emerges.",
        "bull": "Genuine quantum advantage demonstrated on real-world workloads.",
    },
    "robotics": {
        "bear": "Humanoid timelines slip, industrial automation orders soften.",
        "base": "Industrial automation tracks GDP, humanoid stays at demo stage.",
        "bull": "Humanoid commercialization or autonomy stack breaks out commercially.",
    },
    "biotech-frontier": {
        "bear": "Pivotal trial readout disappoints or partnership falls through.",
        "base": "Trials progress on schedule, modest partnership news.",
        "bull": "Positive Phase 3 readout or buyout offer.",
    },
}

DEFAULT_RATIONALES = {
    "bear": "Earnings disappoint or macro decelerates.",
    "base": "Execution stays in line with expectations.",
    "bull": "Earnings surprise or multiple re-rating.",
}


def _weighted_average(values):
    """Each entry is (value, weight). Skips entries where value is None."""
    total_w = 0.0
    total_v = 0.0
    for v, w in values:
        if v is None or w <= 0:
            continue
        total_v += v * w
        total_w += w
    return total_v / total_w if total_w > 0 else None


def _pick_rationale(themes: list[dict], scenario_key: str, ticker: str) -> str:
    """Choose the most relevant themed rationale for this scenario.

    A ticker can have multiple themes — we pick the first one that has a
    rationale for this scenario. Falls back to generic copy if no theme matches.
    """
    for theme in themes or []:
        key = theme.get("key")
        if key in THEME_RATIONALES and scenario_key in THEME_RATIONALES[key]:
            template = THEME_RATIONALES[key][scenario_key]
            return template.replace("{ticker}", ticker or "this stock")
    return DEFAULT_RATIONALES[scenario_key].replace("{ticker}", ticker or "this stock")


def _range_around(midpoint: float, annual_vol: Optional[float], default_pct: float = 0.10) -> tuple[float, float]:
    """Build a price range around a midpoint, sized to volatility.

    Calibrated so a typical mega-cap (~25% vol) gets ~±10% bands and a
    high-beta thematic (~80% vol) gets ~±16% bands. Capped at ±25% so the
    ranges stay informative — wider than that, the scenario stops being a
    "price target" and starts being a tour of the chart.
    """
    if annual_vol is not None and annual_vol > 0:
        half_width = max(default_pct, annual_vol * 0.20)
    else:
        half_width = default_pct
    half_width = min(half_width, 0.25)
    return midpoint * (1 - half_width), midpoint * (1 + half_width)


def build_scenarios(
    current_price: float,
    atr: Optional[float] = None,
    dcf_intrinsic: Optional[float] = None,
    analyst_targets: Optional[dict] = None,
    rsi: Optional[float] = None,
    trend_state: Optional[str] = None,
    themes: Optional[list[dict]] = None,
    ticker: Optional[str] = None,
    currency: str = "",
) -> dict:
    """Return Bear / Base / Bull 12-month scenarios as price ranges.

    Each scenario has:
        priceLow, price (midpoint), priceHigh, returnPct (mid),
        returnLowPct, returnHighPct, probability, rationale (plain English)
    """
    if not current_price or current_price <= 0:
        return {"scenarios": [], "anchors": {}, "horizonMonths": 12, "currency": currency}

    # ── Anchors ──────────────────────────────────────────────────────────────
    atr_pct = (atr / current_price) if atr and current_price else None
    annual_vol = atr_pct * math.sqrt(TRADING_DAYS) if atr_pct else None

    # Technical anchor — 1σ drift bounds.
    tech_bear = current_price * (1 - annual_vol) if annual_vol else None
    tech_base = current_price
    tech_bull = current_price * (1 + annual_vol) if annual_vol else None

    # DCF anchor.
    dcf_bear = dcf_intrinsic * 0.85 if dcf_intrinsic else None
    dcf_base = dcf_intrinsic
    dcf_bull = dcf_intrinsic * 1.15 if dcf_intrinsic else None

    # Analyst anchor.
    a_bear = analyst_targets.get("low") if analyst_targets else None
    a_base = analyst_targets.get("mean") if analyst_targets else None
    a_bull = analyst_targets.get("high") if analyst_targets else None

    # ── Weighted blend for midpoints ─────────────────────────────────────────
    bear_mid = _weighted_average([(tech_bear, 1), (dcf_bear, 1.5), (a_bear, 1)])
    base_mid = _weighted_average([(tech_base, 1), (dcf_base, 1.5), (a_base, 1)])
    bull_mid = _weighted_average([(tech_bull, 1), (dcf_bull, 1.5), (a_bull, 1)])

    # Sanity: keep bear < base < bull. If the weighted blend produces inversion
    # (e.g. DCF says deeply undervalued but analysts cap upside low), swap.
    if bear_mid and base_mid and bear_mid > base_mid:
        bear_mid, base_mid = base_mid, bear_mid
    if base_mid and bull_mid and base_mid > bull_mid:
        base_mid, bull_mid = bull_mid, base_mid

    # ── Probabilities — heuristic from RSI + trend ──────────────────────────
    p_bear, p_base, p_bull = 0.25, 0.50, 0.25
    if rsi is not None:
        if rsi >= 70:
            p_bear, p_base, p_bull = 0.35, 0.45, 0.20
        elif rsi <= 30:
            p_bear, p_base, p_bull = 0.15, 0.45, 0.40
    if trend_state == "uptrend":
        p_bull = min(0.50, p_bull + 0.10)
        p_bear = max(0.10, p_bear - 0.05)
    elif trend_state == "downtrend":
        p_bear = min(0.50, p_bear + 0.10)
        p_bull = max(0.10, p_bull - 0.05)
    total = p_bear + p_base + p_bull
    p_bear, p_base, p_bull = p_bear / total, p_base / total, p_bull / total

    # ── Build the scenarios as ranges ───────────────────────────────────────
    def make(label, key, mid, prob):
        if mid is None:
            return None
        low, high = _range_around(mid, annual_vol)
        return {
            "label": label,
            "key": key,
            "price": round(mid, 2),
            "priceLow": round(low, 2),
            "priceHigh": round(high, 2),
            "returnPct": round((mid - current_price) / current_price * 100, 1),
            "returnLowPct": round((low - current_price) / current_price * 100, 1),
            "returnHighPct": round((high - current_price) / current_price * 100, 1),
            "probability": round(prob * 100),
            "rationale": _pick_rationale(themes or [], key, ticker),
        }

    scenarios = [s for s in (
        make("Bear", "bear", bear_mid, p_bear),
        make("Base", "base", base_mid, p_base),
        make("Bull", "bull", bull_mid, p_bull),
    ) if s is not None]

    anchors = {
        "technical": {
            "bear": round(tech_bear, 2) if tech_bear else None,
            "base": round(tech_base, 2) if tech_base else None,
            "bull": round(tech_bull, 2) if tech_bull else None,
            "annualVolPct": round(annual_vol * 100, 1) if annual_vol else None,
        },
        "dcf": {"intrinsic": round(dcf_intrinsic, 2) if dcf_intrinsic else None},
        "analyst": {"low": a_bear, "mean": a_base, "high": a_bull},
    }

    return {
        "scenarios": scenarios,
        "anchors": anchors,
        "horizonMonths": 12,
        "currency": currency,
        "currentPrice": round(float(current_price), 2),
    }
