import time
import logging
import yfinance as yf

logger = logging.getLogger(__name__)

_session_info = {"type": "default", "error": None}

_info_cache = {}
INFO_CACHE_TTL = 1800  # 30 minutes


def Ticker(symbol: str) -> yf.Ticker:
    return yf.Ticker(symbol)


def get_session():
    return None


def get_session_info():
    return _session_info


def get_cached_info(symbol: str) -> dict | None:
    """Return stock.info with 30-min in-memory cache."""
    cached = _info_cache.get(symbol)
    if cached and (time.time() - cached["ts"]) < INFO_CACHE_TTL:
        return cached["data"]
    stock = yf.Ticker(symbol)
    info = yf_fetch_with_retry(lambda: stock.info)
    if info:
        _info_cache[symbol] = {"ts": time.time(), "data": info}
    return info


def yf_fetch_with_retry(fn, retries=4, base_delay=2):
    """Call fn with exponential backoff on rate limit errors."""
    for attempt in range(retries + 1):
        try:
            return fn()
        except Exception as e:
            err = str(e)
            is_rate_limit = any(k in err for k in ("Rate", "429", "Too Many", "RateLimit"))
            if is_rate_limit and attempt < retries:
                delay = base_delay * (2 ** attempt)
                logger.warning(f"Rate limited, retry {attempt + 1}/{retries} in {delay}s")
                time.sleep(delay)
                continue
            raise
