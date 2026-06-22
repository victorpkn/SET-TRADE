"""
Support / Resistance detection from swing highs and lows.

We treat a bar as a swing high if its `High` is the maximum within a ±N bar
window, and a swing low if its `Low` is the minimum within ±N. Levels are then
clustered: any two levels within `cluster_pct` of each other are merged (the
mean is kept and their swing-counts summed — clusters that were tested more
often become stronger levels).

Designed to feed the Brief tab's S/R section and the scenarios engine.
"""
from __future__ import annotations

import pandas as pd


def _swing_indices(series, window, kind):
    """Return indices where `series` is a local max (kind='high') or min ('low')."""
    n = len(series)
    out = []
    for i in range(window, n - window):
        ref = series.iloc[i]
        if pd.isna(ref):
            continue
        slc = series.iloc[i - window : i + window + 1]
        if kind == "high" and ref == slc.max():
            out.append(i)
        elif kind == "low" and ref == slc.min():
            out.append(i)
    return out


def _cluster_levels(levels, cluster_pct=0.015):
    """Merge price levels that are within `cluster_pct` of each other.

    Returns a list of (price, touches) tuples sorted by price descending. Touches
    is the number of swings that contributed to the cluster — higher means a
    more reliable level.
    """
    if not levels:
        return []
    sorted_levels = sorted(levels)
    clusters = [[sorted_levels[0]]]
    for level in sorted_levels[1:]:
        last_cluster = clusters[-1]
        anchor = last_cluster[0]
        if abs(level - anchor) / anchor <= cluster_pct:
            last_cluster.append(level)
        else:
            clusters.append([level])
    merged = [(sum(c) / len(c), len(c)) for c in clusters]
    merged.sort(key=lambda x: x[0], reverse=True)
    return merged


def detect_levels(
    df: pd.DataFrame,
    current_price: float,
    swing_window: int = 5,
    cluster_pct: float = 0.015,
    max_levels: int = 4,
) -> dict:
    """Detect nearby support and resistance levels.

    Returns:
        {
            "support":    [{"price": float, "distancePct": float, "touches": int}, ...],
            "resistance": [{"price": float, "distancePct": float, "touches": int}, ...],
            "currentPrice": float,
            "nearestSupport":    float | None,
            "nearestResistance": float | None,
            "fiftyTwoWeekHigh": float,
            "fiftyTwoWeekLow":  float,
        }
    """
    if df is None or df.empty or current_price is None or current_price <= 0:
        return {
            "support": [], "resistance": [],
            "currentPrice": current_price,
            "nearestSupport": None, "nearestResistance": None,
            "fiftyTwoWeekHigh": None, "fiftyTwoWeekLow": None,
        }

    highs = df["High"].reset_index(drop=True)
    lows = df["Low"].reset_index(drop=True)

    swing_high_idx = _swing_indices(highs, swing_window, "high")
    swing_low_idx = _swing_indices(lows, swing_window, "low")

    high_levels = [float(highs.iloc[i]) for i in swing_high_idx]
    low_levels = [float(lows.iloc[i]) for i in swing_low_idx]

    high_clusters = _cluster_levels(high_levels, cluster_pct)
    low_clusters = _cluster_levels(low_levels, cluster_pct)

    resistance = [
        {
            "price": round(p, 2),
            "distancePct": round((p - current_price) / current_price * 100, 2),
            "touches": t,
        }
        for p, t in high_clusters
        if p > current_price
    ][:max_levels]

    support = [
        {
            "price": round(p, 2),
            "distancePct": round((p - current_price) / current_price * 100, 2),
            "touches": t,
        }
        for p, t in low_clusters
        if p < current_price
    ][:max_levels]

    nearest_resistance = resistance[-1]["price"] if resistance else None
    nearest_support = support[0]["price"] if support else None

    return {
        "currentPrice": round(float(current_price), 2),
        "support": support,
        "resistance": resistance,
        "nearestSupport": nearest_support,
        "nearestResistance": nearest_resistance,
        "fiftyTwoWeekHigh": round(float(df["High"].max()), 2),
        "fiftyTwoWeekLow": round(float(df["Low"].min()), 2),
    }


def average_true_range(df: pd.DataFrame, period: int = 14) -> float | None:
    """Classic Wilder ATR. Returns the most recent value or None if not enough data."""
    if df is None or len(df) < period + 1:
        return None
    high = df["High"]
    low = df["Low"]
    close = df["Close"]
    prev_close = close.shift(1)

    tr1 = high - low
    tr2 = (high - prev_close).abs()
    tr3 = (low - prev_close).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

    atr = tr.ewm(alpha=1 / period, adjust=False).mean()
    val = atr.iloc[-1]
    return float(val) if pd.notna(val) else None
