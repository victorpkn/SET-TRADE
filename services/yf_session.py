import time
import logging
import yfinance as yf

logger = logging.getLogger(__name__)

_session_info = {"type": "default", "error": None}

_info_cache = {}
_financials_cache = {}
_insider_cache = {}
INFO_CACHE_TTL = 1800  # 30 minutes
FINANCIALS_CACHE_TTL = 3600  # 1 hour — statements only update quarterly
INSIDER_CACHE_TTL = 3600  # 1 hour
NEGATIVE_CACHE_TTL = 30  # 30 seconds — short so frontend retries get a fresh attempt

TRANSIENT_KEYWORDS = (
    "Rate", "429", "Too Many", "RateLimit",
    "Connection", "Timeout", "timeout", "ConnectionError",
    "ReadTimeout", "ConnectTimeout", "RemoteDisconnected",
    "HTTPSConnectionPool", "Max retries", "ChunkedEncodingError",
)


def Ticker(symbol: str) -> yf.Ticker:
    return yf.Ticker(symbol)


def get_session():
    return None


def get_session_info():
    return _session_info


def invalidate_cache(symbol: str):
    """Remove a symbol from all caches so the next call re-fetches."""
    _info_cache.pop(symbol, None)
    _financials_cache.pop(symbol, None)
    _insider_cache.pop(symbol, None)


def get_cached_financials(symbol: str) -> dict | None:
    """Return {financials, balance_sheet, cashflow} DataFrames with 1-hour cache.

    All three statements are fetched together because the Research tab needs all of
    them and one network round-trip per statement is wasteful. Returns None on
    failure so callers can fall back gracefully.
    """
    cached = _financials_cache.get(symbol)
    if cached:
        ttl = FINANCIALS_CACHE_TTL if cached.get("ok") else NEGATIVE_CACHE_TTL
        if (time.time() - cached["ts"]) < ttl:
            return cached["data"]

    stock = yf.Ticker(symbol)
    data = {}
    try:
        data["financials"] = yf_fetch_with_retry(lambda: stock.financials)
    except Exception as e:
        logger.debug(f"get_cached_financials({symbol}) financials failed: {e}")
        data["financials"] = None
    try:
        data["balance_sheet"] = yf_fetch_with_retry(lambda: stock.balance_sheet)
    except Exception as e:
        logger.debug(f"get_cached_financials({symbol}) balance_sheet failed: {e}")
        data["balance_sheet"] = None
    try:
        data["cashflow"] = yf_fetch_with_retry(lambda: stock.cashflow)
    except Exception as e:
        logger.debug(f"get_cached_financials({symbol}) cashflow failed: {e}")
        data["cashflow"] = None

    has_any = any(
        df is not None and not df.empty
        for df in (data["financials"], data["balance_sheet"], data["cashflow"])
    )
    _financials_cache[symbol] = {
        "ts": time.time(),
        "data": data if has_any else None,
        "ok": has_any,
    }
    return data if has_any else None


def get_cached_insider_txns(symbol: str):
    """Return insider_transactions DataFrame with 1-hour cache."""
    cached = _insider_cache.get(symbol)
    if cached:
        ttl = INSIDER_CACHE_TTL if cached.get("ok") else NEGATIVE_CACHE_TTL
        if (time.time() - cached["ts"]) < ttl:
            return cached["data"]

    stock = yf.Ticker(symbol)
    try:
        df = yf_fetch_with_retry(lambda: stock.insider_transactions)
    except Exception as e:
        logger.debug(f"get_cached_insider_txns({symbol}) failed: {e}")
        _insider_cache[symbol] = {"ts": time.time(), "data": None, "ok": False}
        return None

    has_data = df is not None and not df.empty
    _insider_cache[symbol] = {
        "ts": time.time(),
        "data": df if has_data else None,
        "ok": has_data,
    }
    return df if has_data else None


def get_cached_info(symbol: str) -> dict | None:
    """Return stock.info with 30-min cache (2-min negative cache for failures)."""
    cached = _info_cache.get(symbol)
    if cached:
        ttl = INFO_CACHE_TTL if cached.get("ok") else NEGATIVE_CACHE_TTL
        if (time.time() - cached["ts"]) < ttl:
            return cached["data"]

    stock = yf.Ticker(symbol)
    try:
        info = yf_fetch_with_retry(lambda: stock.info)
    except Exception as e:
        logger.warning(f"get_cached_info({symbol}) failed: {e}")
        _info_cache[symbol] = {"ts": time.time(), "data": None, "ok": False}
        return None

    has_useful_data = bool(info and any(
        info.get(k) is not None
        for k in ("currentPrice", "regularMarketPrice", "marketCap", "quoteType")
    ))

    _info_cache[symbol] = {
        "ts": time.time(),
        "data": info if has_useful_data else None,
        "ok": has_useful_data,
    }
    return info if has_useful_data else None


def yf_fetch_with_retry(fn, retries=2, base_delay=1, max_delay=4):
    """Call fn with exponential backoff on transient errors.

    Defaults are conservative (2 retries, 1-4s delay) to stay well under
    Render's 30-second request timeout.
    """
    last_exc = None
    for attempt in range(retries + 1):
        try:
            return fn()
        except Exception as e:
            last_exc = e
            err = str(e) + type(e).__name__
            is_transient = any(k in err for k in TRANSIENT_KEYWORDS)
            if is_transient and attempt < retries:
                delay = min(base_delay * (2 ** attempt), max_delay)
                logger.warning(
                    f"Transient error (attempt {attempt + 1}/{retries}), "
                    f"retrying in {delay}s: {e}"
                )
                time.sleep(delay)
                continue
            raise
    raise last_exc
