import time
import logging
import yfinance as yf

logger = logging.getLogger(__name__)

_session_info = {"type": "default", "error": None}


def Ticker(symbol: str) -> yf.Ticker:
    return yf.Ticker(symbol)


def get_session():
    return None


def get_session_info():
    return _session_info


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
