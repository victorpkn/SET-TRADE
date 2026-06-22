"""
Tactical entry zones — opinionated buy/wait bands, presented as price ranges
with plain-English rationales. Modeled on the way a discretionary PM scribbles
"levels I'd actually act on" rather than a generic technician's S/R list.

Four bands, anchored on a mix of:
  • support clusters (swing-low clusters from services/sr.py)
  • current price + volatility (ATR-derived band widths)
  • valuation context (moat + MoS — wider 'Excellent' band for high-quality names)

Output shape — easy to render as a small table:
    {
      "currentPrice": 46.20,
      "currency": "USD",
      "zones": [
        {"key": "excellent", "label": "Excellent Entry",
         "low": 35.0, "high": 39.0, "current": false, "verdict": "good",
         "rationale": "This is where I'd get aggressive."},
        ...
      ]
    }
"""
from __future__ import annotations

from typing import Optional


def _zone(key, label, low, high, current_price, verdict, rationale):
    contains_current = (
        current_price is not None
        and low is not None
        and (high is None or current_price <= high)
        and current_price >= low
    )
    return {
        "key": key,
        "label": label,
        "low": round(low, 2) if low is not None else None,
        "high": round(high, 2) if high is not None else None,
        "current": contains_current,
        "verdict": verdict,
        "rationale": rationale,
    }


def _band_width(price, atr):
    """Half-width of a band: max(4% of price, 1.5× ATR). Keeps bands neither too
    narrow on low-vol names nor too wide on high-vol ones."""
    pct_width = price * 0.04
    atr_width = (atr or 0) * 1.5
    return max(pct_width, atr_width)


def _deepest_support(support_levels):
    """The lowest priced support cluster — anchor for 'Excellent Entry'.
    `support_levels` is the list from sr.detect_levels()."""
    if not support_levels:
        return None
    return min(lvl["price"] for lvl in support_levels)


def _nearest_support(support_levels):
    if not support_levels:
        return None
    return max(lvl["price"] for lvl in support_levels)


def build_entry_zones(
    current_price: float,
    atr: Optional[float] = None,
    support_levels: Optional[list] = None,
    resistance_levels: Optional[list] = None,
    moat_grade: Optional[str] = None,
    mos_summary_safe: int = 0,
    currency: str = "",
) -> dict:
    """Generate four tactical bands: Excellent / Good / Fair / Expensive.

    Args:
        current_price:    Latest close.
        atr:              14d Wilder ATR; used to size band widths to volatility.
        support_levels:   Output of sr.detect_levels()['support'] (list of dicts).
        resistance_levels:Output of sr.detect_levels()['resistance'].
        moat_grade:       "Wide" / "Narrow" / "None" — quality tilt for 'Expensive' threshold.
        mos_summary_safe: 0–3, how many MoS methods (DCF, owner, graham) say
                          there's a margin of safety. Shifts where 'Expensive' starts.
        currency:         Display currency (USD, THB, etc.).
    """
    if not current_price or current_price <= 0:
        return {"currentPrice": current_price, "currency": currency, "zones": []}

    width = _band_width(current_price, atr)
    deepest = _deepest_support(support_levels)
    nearest = _nearest_support(support_levels)

    # ── Excellent Entry ──────────────────────────────────────────────────────
    # Anchor: deepest swing-low cluster, OR 22% below current as a fallback.
    # We use the deepest support only when it's a *reasonable* aggressive zone
    # (15–30% below current). A historical low 50% below current is rarely
    # actionable — better to project a band 22% down using current dynamics.
    if deepest and current_price * 0.70 <= deepest <= current_price * 0.85:
        excellent_mid = deepest
    else:
        excellent_mid = current_price * 0.78
    excellent_low = excellent_mid - width
    excellent_high = excellent_mid + width * 0.8

    # ── Good Entry ───────────────────────────────────────────────────────────
    # Anchor: nearest meaningful support cluster, OR 12% below current.
    if nearest and current_price * 0.85 <= nearest <= current_price * 0.95:
        good_mid = nearest
    else:
        good_mid = current_price * 0.88
    good_low = good_mid - width
    good_high = good_mid + width

    # If excellent and good overlap, push excellent down.
    if good_low <= excellent_high:
        excellent_high = good_low - 0.01

    # ── Fair Entry ───────────────────────────────────────────────────────────
    # Centered tightly around current price.
    fair_low = current_price - width * 0.6
    fair_high = current_price + width * 0.8

    # Make sure good < fair < expensive.
    if fair_low <= good_high:
        good_high = fair_low - 0.01

    # ── Expensive ───────────────────────────────────────────────────────────
    # Open-ended upper band. Threshold rises for higher-quality businesses
    # (a wide-moat compounder is allowed to trade richer), and falls when the
    # valuation already screams expensive.
    quality_premium = {"Wide": 1.20, "Narrow": 1.15, "None": 1.10}.get(moat_grade, 1.15)
    if mos_summary_safe == 0:
        # Stock is already above intrinsic value on every method — be stricter.
        quality_premium -= 0.05
    expensive_threshold = max(fair_high * 1.02, current_price * quality_premium)

    # ── Rationales — short, opinionated, in PM voice ─────────────────────────
    rationale_excellent = "Aggressive buy zone — load up here."
    rationale_good = "Very attractive risk/reward — start scaling in."
    rationale_fair = (
        "Roughly where we are now — reasonable entry but limited downside cushion."
        if fair_low <= current_price <= fair_high
        else "Reasonable entry but limited downside cushion."
    )
    rationale_expensive = (
        "Want to see earnings and execution catch up before paying this much."
        if moat_grade != "Wide"
        else "Wide-moat premium still has to be earned — wait for a re-rating catalyst or pullback."
    )

    zones = [
        _zone("excellent", "Excellent Entry", excellent_low, excellent_high,
              current_price, "good", rationale_excellent),
        _zone("good", "Good Entry", good_low, good_high,
              current_price, "good", rationale_good),
        _zone("fair", "Fair Entry", fair_low, fair_high,
              current_price, "neutral", rationale_fair),
        _zone("expensive", "Expensive", expensive_threshold, None,
              current_price, "bad", rationale_expensive),
    ]

    return {
        "currentPrice": round(float(current_price), 2),
        "currency": currency,
        "zones": zones,
    }
