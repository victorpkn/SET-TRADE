"""
Tactical theme tagging — maps tickers to high-conviction themes (AI infra,
data centers, semis, space, defense, energy transition, quantum, robotics,
frontier biotech). Used by:
  - the welcome page quick-pick chips
  - the portfolio view's theme-concentration breakdown
  - the Brief tab's "portfolio fit" section

Themes live in `data/themes.json` for easy curation without code edits.
"""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache

logger = logging.getLogger(__name__)

THEMES_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "themes.json")


@lru_cache(maxsize=1)
def _load_themes() -> dict:
    try:
        with open(THEMES_PATH, "r") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Could not load themes.json: {e}")
        return {"themes": []}


def list_themes() -> list[dict]:
    """Return all themes for the UI (welcome page chips, portfolio breakdown legend)."""
    return _load_themes().get("themes", [])


def themes_for_ticker(ticker: str) -> list[dict]:
    """Return every theme that contains the given ticker.

    A ticker can belong to multiple themes (e.g. NVDA is both AI infra and semis).
    Returned dicts are slim — only key/label/icon/color, no ticker lists.
    """
    sym = ticker.strip().upper().split(".")[0]  # strip .BK suffix for SET stocks
    matches = []
    for theme in list_themes():
        if sym in [t.upper() for t in theme.get("tickers", [])]:
            matches.append({
                "key": theme["key"],
                "label": theme["label"],
                "icon": theme.get("icon"),
                "color": theme.get("color"),
            })
    return matches


def aggregate_portfolio_themes(holdings: list[dict]) -> list[dict]:
    """Aggregate $ value by theme for a portfolio.

    Each holding must have `ticker` and `value`. A holding that maps to N themes
    contributes its full value to each theme (themes overlap intentionally — a
    semiconductor stock is exposure to both "semis" and "AI infra"). Themes are
    sorted by value descending.
    """
    if not holdings:
        return []

    bucket: dict[str, dict] = {}
    for h in holdings:
        ticker = h.get("ticker", "")
        value = h.get("value", 0) or 0
        for theme in themes_for_ticker(ticker):
            key = theme["key"]
            if key not in bucket:
                bucket[key] = {
                    "key": key,
                    "label": theme["label"],
                    "icon": theme["icon"],
                    "color": theme["color"],
                    "value": 0.0,
                    "tickers": [],
                }
            bucket[key]["value"] += value
            bucket[key]["tickers"].append(ticker)

    out = sorted(bucket.values(), key=lambda x: -x["value"])
    for item in out:
        item["value"] = round(item["value"], 2)
        item["tickers"] = sorted(set(item["tickers"]))
    return out
