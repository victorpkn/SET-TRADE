"""
Narrative engine — turns structured ticker inputs into an analyst-style brief.

Every sentence is generated from structured numeric inputs (price, EMA stack,
RSI, MACD, ATR, S/R levels, moat score, MoS, etc.). No hardcoded paragraphs.
Deterministic, fast, and easy to tune.

The output structure mirrors the 10 sections of a sell-side research note:
    1. Current technical setup
    2. Trend strength
    3. Momentum
    4. Support & resistance
    5. Trader entry view
    6. Long-term investor view
    7. Bear / base / bull scenarios
    8. Key catalysts
    9. Key risks
    10. Portfolio fit
"""
from __future__ import annotations

from typing import Optional


# ─────────────────────────────────────────────────────────────────────────────
# Helpers — turn raw values into qualitative labels
# ─────────────────────────────────────────────────────────────────────────────

def _pct_distance(price, ref):
    if not price or not ref:
        return None
    return (price - ref) / ref


def _classify_setup(price, ema20, ema50, ema200, rsi, atr_pct):
    """Return one of: extended, breaking out, trending, consolidating, pulling back,
    correcting, mixed."""
    above_20 = _pct_distance(price, ema20)
    above_50 = _pct_distance(price, ema50)
    above_200 = _pct_distance(price, ema200)

    if rsi is not None and rsi >= 75 and above_50 is not None and above_50 > 0.20:
        return "extended"
    if (above_20 is not None and above_50 is not None and
            above_20 > 0 and above_50 > 0.03 and
            atr_pct is not None and atr_pct > 0.03 and
            rsi is not None and 55 <= rsi <= 75):
        return "breaking out"
    if (above_50 is not None and above_50 > 0.05 and
            above_200 is not None and above_200 > 0):
        return "trending higher"
    if (above_50 is not None and abs(above_50) < 0.03 and
            atr_pct is not None and atr_pct < 0.025):
        return "consolidating"
    if above_50 is not None and -0.10 <= above_50 <= -0.03:
        return "pulling back"
    if above_50 is not None and above_50 < -0.10:
        return "correcting"
    return "mixed"


def _trend_state(price, ema20, ema50, ema200):
    """Higher-level trend classification — uptrend / downtrend / range."""
    if not (price and ema20 and ema50 and ema200):
        return "unclear"
    if price > ema20 > ema50 > ema200:
        return "uptrend"
    if price < ema20 < ema50 < ema200:
        return "downtrend"
    return "range"


def _rsi_label(rsi):
    if rsi is None:
        return "unavailable", "neutral"
    if rsi >= 70:
        return "overbought", "bearish"
    if rsi >= 55:
        return "bullish momentum", "bullish"
    if rsi <= 30:
        return "oversold", "bullish"
    if rsi <= 45:
        return "bearish momentum", "bearish"
    return "neutral", "neutral"


def _macd_label(macd_line, signal_line, histogram):
    if macd_line is None or signal_line is None:
        return "unavailable", "neutral"
    if macd_line > signal_line and (histogram or 0) > 0:
        return "bullish (above signal, histogram rising)", "bullish"
    if macd_line > signal_line:
        return "bullish (above signal, momentum fading)", "neutral"
    if macd_line < signal_line and (histogram or 0) < 0:
        return "bearish (below signal, histogram falling)", "bearish"
    return "bearish (below signal, attempting reversal)", "neutral"


def _verdict_color(label):
    if label == "bullish":
        return "good"
    if label == "bearish":
        return "bad"
    return "neutral"


def _fmt_price(p, ccy=""):
    if p is None:
        return "—"
    return f"{ccy + ' ' if ccy else ''}{p:.2f}"


def _fmt_pct(p, digits=1):
    if p is None:
        return "—"
    return f"{p:.{digits}f}%"


# ─────────────────────────────────────────────────────────────────────────────
# Section builders
# ─────────────────────────────────────────────────────────────────────────────

def _build_setup_section(price, ema20, ema50, ema200, rsi, atr_pct, setup_state, ccy):
    bits = [
        f"Technically, this stock is **{setup_state}**."
    ]
    if ema50 is not None and price is not None:
        diff = (price - ema50) / ema50 * 100
        direction = "above" if diff > 0 else "below"
        bits.append(f"Price sits {abs(diff):.1f}% {direction} the 50-day EMA ({_fmt_price(ema50, ccy)}).")
    if ema200 is not None and price is not None:
        diff200 = (price - ema200) / ema200 * 100
        if diff200 > 0:
            bits.append(f"Long-term trend is intact — price is {diff200:.1f}% above the 200-day EMA.")
        else:
            bits.append(f"Long-term trend is impaired — price is {abs(diff200):.1f}% below the 200-day EMA.")
    if atr_pct is not None:
        bits.append(f"Daily ATR is {atr_pct * 100:.1f}% — {'high' if atr_pct > 0.04 else 'normal' if atr_pct > 0.02 else 'low'} volatility regime.")

    verdict = "good" if setup_state in ("trending higher", "breaking out") else (
        "bad" if setup_state in ("correcting", "extended") else "neutral"
    )
    return {
        "key": "setup",
        "title": "Current Technical Setup",
        "verdict": verdict,
        "state": setup_state,
        "text": " ".join(bits),
    }


def _build_trend_section(price, ema20, ema50, ema100, ema200, ccy):
    state = _trend_state(price, ema20, ema50, ema200)
    bits = []
    if state == "uptrend":
        bits.append("**Trend is bullish.** Price is stacked above all four moving averages in the correct order (20 > 50 > 100 > 200).")
    elif state == "downtrend":
        bits.append("**Trend is bearish.** Price is below all four moving averages in the wrong order — this is a confirmed downtrend.")
    elif state == "range":
        bits.append("**Trend is mixed.** Moving averages are tangled — the stock is in a range or transitioning.")
    else:
        bits.append("Trend signal is unavailable — not enough moving-average data.")

    if ema200 is not None and price is not None:
        slope_note = "rising" if price > ema200 else "flat or declining"
        bits.append(f"The 200-day EMA sits at {_fmt_price(ema200, ccy)} and is {slope_note} relative to current price.")

    return {
        "key": "trend",
        "title": "Trend Strength",
        "verdict": "good" if state == "uptrend" else ("bad" if state == "downtrend" else "neutral"),
        "state": state,
        "text": " ".join(bits),
    }


def _build_momentum_section(rsi, macd_line, signal_line, histogram):
    rsi_text, rsi_class = _rsi_label(rsi)
    macd_text, macd_class = _macd_label(macd_line, signal_line, histogram)

    bits = []
    if rsi is not None:
        bits.append(f"RSI(14) at {rsi:.1f} — **{rsi_text}**.")
    if macd_line is not None:
        bits.append(f"MACD is {macd_text}.")

    bullish_count = sum(1 for x in (rsi_class, macd_class) if x == "bullish")
    bearish_count = sum(1 for x in (rsi_class, macd_class) if x == "bearish")
    if bullish_count > bearish_count:
        verdict = "good"
        bits.append("Momentum agrees on the upside.")
    elif bearish_count > bullish_count:
        verdict = "bad"
        bits.append("Momentum agrees on the downside.")
    else:
        verdict = "neutral"
        bits.append("Momentum is split.")

    return {
        "key": "momentum",
        "title": "Momentum",
        "verdict": verdict,
        "rsi": round(rsi, 1) if rsi is not None else None,
        "text": " ".join(bits),
    }


def _build_sr_section(sr_data, price, ccy):
    if not sr_data:
        return None

    nearest_s = sr_data.get("nearestSupport")
    nearest_r = sr_data.get("nearestResistance")
    bits = []

    if nearest_s and price:
        dist_s = (price - nearest_s) / price * 100
        bits.append(f"Nearest support sits at {_fmt_price(nearest_s, ccy)} ({dist_s:.1f}% below current).")
    else:
        bits.append("No clear support level below current price within the window — price is near recent lows.")

    if nearest_r and price:
        dist_r = (nearest_r - price) / price * 100
        bits.append(f"Nearest resistance sits at {_fmt_price(nearest_r, ccy)} ({dist_r:.1f}% above).")
    else:
        bits.append("No clear resistance above — price is at or near recent highs (clean tape).")

    w52_h = sr_data.get("fiftyTwoWeekHigh")
    w52_l = sr_data.get("fiftyTwoWeekLow")
    if price and w52_h and w52_l and w52_h > w52_l:
        pct_in_range = (price - w52_l) / (w52_h - w52_l) * 100
        if pct_in_range > 80:
            bits.append(f"Trading in the top {100 - pct_in_range:.0f}% of the 52-week range.")
        elif pct_in_range < 20:
            bits.append(f"Trading in the bottom {pct_in_range:.0f}% of the 52-week range.")

    return {
        "key": "sr",
        "title": "Support & Resistance",
        "verdict": "neutral",
        "support": sr_data.get("support", []),
        "resistance": sr_data.get("resistance", []),
        "text": " ".join(bits),
    }


def _build_trader_section(setup_state, sr_data, atr_pct, price, ccy):
    """Tactical entry guidance: where would a swing trader want to act?"""
    bits = ["**For traders:** "]

    nearest_s = sr_data.get("nearestSupport") if sr_data else None
    nearest_r = sr_data.get("nearestResistance") if sr_data else None

    if setup_state == "extended":
        bits.append(f"avoid chasing here. Wait for a pullback toward {_fmt_price(nearest_s, ccy) if nearest_s else 'the 20-day EMA'} before initiating.")
    elif setup_state == "breaking out":
        bits.append(f"a confirmed breakout above {_fmt_price(nearest_r, ccy) if nearest_r else 'recent highs'} is your entry trigger. Use a stop just below {_fmt_price(nearest_s, ccy) if nearest_s else 'the 20-day EMA'}.")
    elif setup_state == "consolidating":
        bits.append("range-trade the structure — buy near support, sell near resistance until one side breaks.")
    elif setup_state in ("pulling back",):
        bits.append(f"this is a tactical buy zone if the prior trend remains intact. Add near {_fmt_price(nearest_s, ccy) if nearest_s else 'support'} with tight risk.")
    elif setup_state == "correcting":
        bits.append("don't fight the tape — wait for stabilization (price reclaiming the 50-day EMA) before re-engaging.")
    elif setup_state == "trending higher":
        bits.append(f"trend is your friend — buy dips to the 20- or 50-day EMA. Trail stops below structural support at {_fmt_price(nearest_s, ccy) if nearest_s else 'the rising 50-day'}.")
    else:
        bits.append("signals are mixed — small position size or stay flat until the structure clarifies.")

    if atr_pct is not None:
        suggested_stop_pct = max(2.0, atr_pct * 200)  # 2× ATR floor at 2%
        bits.append(f"Volatility-adjusted stop suggestion: ~{suggested_stop_pct:.1f}% (2× ATR).")

    verdict = "good" if setup_state in ("breaking out", "trending higher", "pulling back") else (
        "bad" if setup_state in ("extended", "correcting") else "neutral"
    )
    return {
        "key": "trader",
        "title": "Trader Entry View",
        "verdict": verdict,
        "text": " ".join(bits),
    }


def _build_investor_section(moat_score, moat_grade, mgmt_grade, mos_methods, dcf_intrinsic, price, ccy):
    bits = ["**For long-term investors:** "]

    if moat_score is None:
        bits.append("the qualitative moat picture is unclear (financial history is thin).")
    elif moat_grade == "Wide":
        bits.append(f"this is a wide-moat business (score {moat_score}/100). The durable competitive advantage justifies a longer holding period.")
    elif moat_grade == "Narrow":
        bits.append(f"this is a narrow-moat business (score {moat_score}/100). Position sizing and entry valuation matter more here.")
    else:
        bits.append(f"the moat is weak or absent (score {moat_score}/100) — treat any position as a trade, not a long-term compound.")

    if mgmt_grade and mgmt_grade != "N/A":
        if mgmt_grade in ("A",):
            bits.append("Management quality is top-tier.")
        elif mgmt_grade in ("B",):
            bits.append("Management is solid.")
        elif mgmt_grade in ("C", "D"):
            bits.append("Management has flags worth understanding before committing capital.")

    if mos_methods:
        safe = sum(1 for m in mos_methods if m.get("verdict") == "good")
        total = len(mos_methods)
        if safe == total and total >= 2:
            bits.append(f"All {total} valuation methods show a margin of safety — the price is attractive for accumulation.")
        elif safe >= 2:
            bits.append(f"{safe} of {total} methods show margin of safety — reasonable entry.")
        elif safe == 0:
            bits.append("Valuation looks stretched across all methods — wait for a better price or scale in gradually.")

    if dcf_intrinsic and price:
        upside = (dcf_intrinsic - price) / price * 100
        if upside > 0:
            bits.append(f"DCF implies {upside:.0f}% upside to intrinsic value.")
        else:
            bits.append(f"DCF implies {abs(upside):.0f}% downside to intrinsic value.")

    verdict = "neutral"
    if moat_grade == "Wide" and mos_methods and sum(1 for m in mos_methods if m["verdict"] == "good") >= 2:
        verdict = "good"
    elif moat_grade == "None" or (mos_methods and not any(m["verdict"] == "good" for m in mos_methods)):
        verdict = "bad"

    return {
        "key": "investor",
        "title": "Long-Term Investor View",
        "verdict": verdict,
        "text": " ".join(bits),
    }


def _build_entry_zones_section(zones_data):
    """Tactical entry zones section — opinionated buy bands with ranges."""
    if not zones_data or not zones_data.get("zones"):
        return None
    zones = zones_data["zones"]
    in_band = next((z["label"] for z in zones if z.get("current")), None)
    if in_band:
        text = f"Current price sits inside the **{in_band}** band."
    else:
        text = "Current price falls outside the defined entry bands — see scenarios for context."
    return {
        "key": "entry_zones",
        "title": "My Support Levels",
        "verdict": "neutral",
        "zones": zones,
        "currentPrice": zones_data.get("currentPrice"),
        "text": text,
    }


def _build_scenarios_section(scenarios_data):
    if not scenarios_data or not scenarios_data.get("scenarios"):
        return None
    scenarios = scenarios_data["scenarios"]
    base = next((s for s in scenarios if s["key"] == "base"), None)
    if base:
        text = f"Base case implies {_fmt_pct(base['returnPct'])} return over 12 months ({base['probability']}% probability)."
    else:
        text = "Scenario inputs are insufficient for a robust 12-month projection."
    return {
        "key": "scenarios",
        "title": "My 12-Month Outlook",
        "verdict": "neutral",
        "scenarios": scenarios,
        "anchors": scenarios_data.get("anchors", {}),
        "horizonMonths": scenarios_data.get("horizonMonths", 12),
        "currentPrice": scenarios_data.get("currentPrice"),
        "text": text,
    }


def _build_catalysts_section(info, themes, moat_grade):
    catalysts = []

    earnings_date = info.get("nextEarningsDate") or info.get("earningsDate")
    if earnings_date:
        catalysts.append({
            "type": "earnings",
            "label": f"Next earnings report",
            "detail": str(earnings_date),
        })

    # Theme-driven catalysts — generic but contextual.
    theme_keys = {t["key"] for t in themes}
    if "ai-infra" in theme_keys or "data-centers" in theme_keys:
        catalysts.append({
            "type": "industry",
            "label": "Hyperscaler capex cycle",
            "detail": "Quarterly AWS/Azure/GCP capex guidance moves entire AI-infra basket.",
        })
    if "semis" in theme_keys:
        catalysts.append({
            "type": "industry",
            "label": "Foundry utilization & node transitions",
            "detail": "TSMC monthly revenue and N2 ramp commentary drive the group.",
        })
    if "space" in theme_keys:
        catalysts.append({
            "type": "industry",
            "label": "Launch cadence & DoD contract awards",
            "detail": "Each successful launch + booked contract re-rates the position.",
        })
    if "defense" in theme_keys:
        catalysts.append({
            "type": "industry",
            "label": "DoD budget cycle & FMS deals",
            "detail": "Continuing resolutions and supplemental aid packages move the names.",
        })
    if "energy-transition" in theme_keys:
        catalysts.append({
            "type": "industry",
            "label": "Power demand growth & SMR licensing",
            "detail": "AI-driven power demand revisions and NRC milestones for SMRs.",
        })

    if moat_grade == "Wide":
        catalysts.append({
            "type": "fundamental",
            "label": "Compounding moat",
            "detail": "Time itself is a catalyst — earnings power compounds while peers struggle.",
        })

    if not catalysts:
        catalysts.append({
            "type": "fundamental",
            "label": "Next earnings print",
            "detail": "Watch for guidance changes and capital-return updates.",
        })

    return {
        "key": "catalysts",
        "title": "Key Catalysts",
        "verdict": "neutral",
        "items": catalysts,
    }


def _build_risks_section(setup_state, moat_grade, mos_methods, themes, atr_pct, debt_to_equity):
    risks = []

    if setup_state == "extended":
        risks.append({"label": "Extended technicals", "detail": "Mean-reversion risk — chasing here adds drawdown risk."})
    if setup_state == "correcting":
        risks.append({"label": "Active downtrend", "detail": "Catching a falling knife — wait for stabilization."})

    if moat_grade == "None":
        risks.append({"label": "No durable moat", "detail": "Commoditization risk — margins can compress in any downturn."})

    if mos_methods and not any(m["verdict"] == "good" for m in mos_methods):
        risks.append({"label": "Valuation risk", "detail": "Price exceeds intrinsic value on every method — multiple compression is the main downside."})

    if atr_pct is not None and atr_pct > 0.05:
        risks.append({"label": "High volatility", "detail": f"Daily ATR {atr_pct * 100:.1f}% — size positions accordingly."})

    if debt_to_equity is not None and debt_to_equity > 150:
        risks.append({"label": "Leverage risk", "detail": f"D/E ratio of {debt_to_equity:.0f}% leaves little buffer in a downturn."})

    theme_keys = {t["key"] for t in themes}
    if "quantum" in theme_keys:
        risks.append({"label": "Pre-revenue technology", "detail": "Quantum is a binary, technology-risk bet — expect violent moves on milestones."})
    if "space" in theme_keys:
        risks.append({"label": "Launch failure & program risk", "detail": "Single-event risk can wipe quarters of progress."})
    if "biotech-frontier" in theme_keys:
        risks.append({"label": "Binary clinical outcomes", "detail": "Trial readouts can re-rate or collapse the equity overnight."})

    if not risks:
        risks.append({"label": "General market risk", "detail": "Broad market drawdowns, sector rotation, and macro shocks."})

    return {
        "key": "risks",
        "title": "Key Risks",
        "verdict": "neutral",
        "items": risks,
    }


def _build_portfolio_fit_section(themes, moat_grade, atr_pct, mos_methods):
    bits = ["**Portfolio fit:** "]

    if themes:
        theme_names = ", ".join(t["label"] for t in themes[:3])
        bits.append(f"primary exposure is **{theme_names}**.")
    else:
        bits.append("no tactical theme tag — treat as opportunistic single-name.")

    is_safe = mos_methods and sum(1 for m in mos_methods if m["verdict"] == "good") >= 2

    if moat_grade == "Wide" and is_safe:
        bits.append("Core-position candidate (up to 5–8% of portfolio).")
        sizing = "core"
    elif moat_grade == "Wide":
        bits.append("Quality compounder — accumulate on dips but avoid full-size at premium valuations.")
        sizing = "build-on-dips"
    elif moat_grade == "Narrow" and is_safe:
        bits.append("Tactical position — 2–4% of portfolio with disciplined stop-loss.")
        sizing = "tactical"
    elif atr_pct is not None and atr_pct > 0.05:
        bits.append("High-beta thematic — size small (1–2%) and treat as venture-style.")
        sizing = "venture"
    else:
        bits.append("Mid-conviction position — 2–3% with active monitoring.")
        sizing = "mid"

    bits.append("Concentration alert thresholds: 30% (warning), 50% (heavy), 65% (extreme).")

    return {
        "key": "portfolio",
        "title": "Portfolio Fit",
        "verdict": "neutral",
        "sizing": sizing,
        "themes": themes,
        "text": " ".join(bits),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Public: assemble the full Brief
# ─────────────────────────────────────────────────────────────────────────────

def build_brief(inputs: dict) -> dict:
    """Build the 10-section brief from a dict of structured inputs.

    Expected keys in `inputs`:
        price, ema20, ema50, ema100, ema200, rsi, macd_line, macd_signal,
        macd_hist, atr, atr_pct, sr_data, scenarios_data, moat_score, moat_grade,
        mgmt_grade, mos_methods, dcf_intrinsic, themes, info, currency, name,
        ticker, debtToEquity
    """
    price = inputs.get("price")
    ema20 = inputs.get("ema20")
    ema50 = inputs.get("ema50")
    ema100 = inputs.get("ema100")
    ema200 = inputs.get("ema200")
    rsi = inputs.get("rsi")
    macd_line = inputs.get("macd_line")
    macd_signal = inputs.get("macd_signal")
    macd_hist = inputs.get("macd_hist")
    atr_pct = inputs.get("atr_pct")
    sr_data = inputs.get("sr_data") or {}
    entry_zones_data = inputs.get("entry_zones_data") or {}
    scenarios_data = inputs.get("scenarios_data") or {}
    moat_score = inputs.get("moat_score")
    moat_grade = inputs.get("moat_grade")
    mgmt_grade = inputs.get("mgmt_grade")
    mos_methods = inputs.get("mos_methods") or []
    dcf_intrinsic = inputs.get("dcf_intrinsic")
    themes = inputs.get("themes") or []
    info = inputs.get("info") or {}
    ccy = inputs.get("currency", "")
    debt_to_equity = inputs.get("debtToEquity")

    setup_state = _classify_setup(price, ema20, ema50, ema200, rsi, atr_pct)

    sections = [
        _build_setup_section(price, ema20, ema50, ema200, rsi, atr_pct, setup_state, ccy),
        _build_trend_section(price, ema20, ema50, ema100, ema200, ccy),
        _build_momentum_section(rsi, macd_line, macd_signal, macd_hist),
        _build_sr_section(sr_data, price, ccy),
        _build_entry_zones_section(entry_zones_data),
        _build_trader_section(setup_state, sr_data, atr_pct, price, ccy),
        _build_investor_section(moat_score, moat_grade, mgmt_grade, mos_methods, dcf_intrinsic, price, ccy),
        _build_scenarios_section(scenarios_data),
        _build_catalysts_section(info, themes, moat_grade),
        _build_risks_section(setup_state, moat_grade, mos_methods, themes, atr_pct, debt_to_equity),
        _build_portfolio_fit_section(themes, moat_grade, atr_pct, mos_methods),
    ]

    sections = [s for s in sections if s is not None]

    # One-line executive summary at the top — synthesizes setup + investor view.
    headline = _headline(setup_state, moat_grade, mos_methods)

    return {
        "ticker": inputs.get("ticker"),
        "name": inputs.get("name"),
        "currency": ccy,
        "price": price,
        "setupState": setup_state,
        "headline": headline,
        "sections": sections,
        "themes": themes,
    }


def _headline(setup_state, moat_grade, mos_methods):
    """One-line headline summary at the top of the Brief."""
    technical = {
        "extended": "Technically extended",
        "breaking out": "Breaking out",
        "trending higher": "In a clean uptrend",
        "consolidating": "Consolidating",
        "pulling back": "Tactical pullback",
        "correcting": "In active correction",
        "mixed": "Mixed technical setup",
    }.get(setup_state, "Mixed technical setup")

    if moat_grade == "Wide":
        quality = "wide-moat quality"
    elif moat_grade == "Narrow":
        quality = "narrow-moat quality"
    elif moat_grade == "None":
        quality = "no durable moat"
    else:
        quality = "qualitative picture unclear"

    if mos_methods:
        safe = sum(1 for m in mos_methods if m.get("verdict") == "good")
        if safe >= 2:
            valuation = "with margin of safety"
        elif safe == 1:
            valuation = "trading near fair value"
        else:
            valuation = "above intrinsic value"
    else:
        valuation = "valuation inconclusive"

    return f"{technical} · {quality} · {valuation}."
