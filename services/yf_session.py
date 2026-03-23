import logging
import yfinance as yf

logger = logging.getLogger(__name__)

_session = None
_session_error = None

try:
    from curl_cffi import requests as cffi_requests
    _session = cffi_requests.Session(impersonate="chrome")
    logger.info("yf_session: using curl_cffi (chrome impersonation)")
except Exception as exc:
    _session_error = f"{type(exc).__name__}: {exc}"
    logger.warning(f"yf_session: curl_cffi failed ({_session_error}), falling back to requests")
    import requests as _req
    _session = _req.Session()
    _session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        )
    })


def Ticker(symbol: str) -> yf.Ticker:
    return yf.Ticker(symbol, session=_session)


def get_session():
    return _session


def get_session_info():
    return {
        "type": type(_session).__name__,
        "module": type(_session).__module__,
        "error": _session_error,
    }
