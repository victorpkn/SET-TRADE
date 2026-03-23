import time
import logging
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed

import yfinance as yf
from services.yf_session import Ticker

logger = logging.getLogger(__name__)

RATIO_KEYS = [
    "trailingPE", "forwardPE", "priceToBook", "priceToSalesTrailing12Months",
    "enterpriseToEbitda", "profitMargins", "operatingMargins", "returnOnEquity",
    "returnOnAssets", "currentRatio", "debtToEquity", "quickRatio",
    "dividendYield", "payoutRatio", "revenueGrowth", "earningsGrowth",
]

_cache = {}
CACHE_TTL = 7200  # 2 hours

MAX_PEERS = 8


def _fetch_peer_ratios(symbol: str) -> dict | None:
    try:
        stock = Ticker(symbol)
        info = stock.info
        if not info:
            return None
        out = {}
        for k in RATIO_KEYS:
            v = info.get(k)
            if v is not None and isinstance(v, (int, float)):
                out[k] = v
        return out if out else None
    except Exception:
        return None


def fetch_industry_medians(industry_key: str, exclude_symbol: str = "") -> dict:
    """Return {ratio_key: median_value} for an industry, cached for 2 hours."""
    if not industry_key:
        return {}

    cached = _cache.get(industry_key)
    if cached and (time.time() - cached["ts"]) < CACHE_TTL:
        return cached["data"]

    try:
        ind = yf.Industry(industry_key)
        top = ind.top_companies
        if top is None or top.empty:
            return {}
        peer_symbols = [s for s in list(top.index)[:MAX_PEERS]
                        if s.upper() != exclude_symbol.upper()]
    except Exception as e:
        logger.warning(f"Failed to fetch industry peers for {industry_key}: {e}")
        return {}

    all_ratios = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(_fetch_peer_ratios, sym): sym for sym in peer_symbols}
        for future in as_completed(futures):
            r = future.result()
            if r:
                all_ratios.append(r)

    if len(all_ratios) < 2:
        return {}

    medians = {}
    for key in RATIO_KEYS:
        vals = [r[key] for r in all_ratios if key in r]
        if len(vals) >= 2:
            medians[key] = round(statistics.median(vals), 4)

    result = {"medians": medians, "peerCount": len(all_ratios)}
    _cache[industry_key] = {"ts": time.time(), "data": result}
    return result
