import time
import logging
import yfinance as yf

logger = logging.getLogger(__name__)

_session_info = {"type": "default", "error": None}

_info_cache = {}
INFO_CACHE_TTL = 1800  # 30 minutes
NEGATIVE_CACHE_TTL = 120  # 2 minutes for failed lookups

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
    """Remove a symbol from the info cache so the next call re-fetches."""
    _info_cache.pop(symbol, None)


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


def yf_fetch_with_retry(fn, retries=4, base_delay=2):
    """Call fn with exponential backoff on transient errors."""
    last_exc = None
    for attempt in range(retries + 1):
        try:
            return fn()
        except Exception as e:
            last_exc = e
            err = str(e) + type(e).__name__
            is_transient = any(k in err for k in TRANSIENT_KEYWORDS)
            if is_transient and attempt < retries:
                delay = base_delay * (2 ** attempt)
                logger.warning(
                    f"Transient error (attempt {attempt + 1}/{retries}), "
                    f"retrying in {delay}s: {e}"
                )
                time.sleep(delay)
                continue
            raise
    raise last_exc
