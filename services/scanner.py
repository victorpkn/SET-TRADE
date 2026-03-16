import time
import yfinance as yf
import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed
from ta.trend import SMAIndicator, MACD
from ta.momentum import StochasticOscillator
from services.stock_data import normalize_ticker

_cache = {}
CACHE_TTL = 900  # 15 minutes

DEFAULT_SCAN_SET = [
    "PTT", "AOT", "CPALL", "KBANK", "SCB", "ADVANC", "GULF", "BDMS",
    "DELTA", "SCC", "BBL", "CPN", "MINT", "BH", "HMPRO", "IVL",
    "OR", "BEM", "BTS", "SAWAD", "EA", "BGRIM", "KCE", "COM7",
]

DEFAULT_SCAN_US = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM",
    "V", "UNH", "MA", "HD", "PG", "JNJ", "NFLX", "DIS",
    "COST", "AMD", "CRM", "PYPL", "INTC", "BA", "NKE", "SBUX",
]


def _compute_signal_fast(symbol: str) -> dict | None:
    """Compute signals for a single ticker. Returns None on failure."""
    try:
        stock = yf.Ticker(symbol)
        df = stock.history(period="3mo", interval="1d")
        if df.empty or len(df) < 30:
            return None

        close = df["Close"]
        high = df["High"]
        low = df["Low"]

        sma_s = SMAIndicator(close=close, window=20).sma_indicator()
        sma_l = SMAIndicator(close=close, window=50).sma_indicator()
        macd_obj = MACD(close=close, window_slow=26, window_fast=12, window_sign=9)
        macd_line = macd_obj.macd()
        macd_signal = macd_obj.macd_signal()
        macd_hist = macd_obj.macd_diff()
        stoch_obj = StochasticOscillator(high=high, low=low, close=close, window=14, smooth_window=3)
        stoch_k = stoch_obj.stoch()
        stoch_d = stoch_obj.stoch_signal()

        score = 0
        signals = []

        ss = sma_s.dropna()
        sl = sma_l.dropna()
        if len(ss) and len(sl):
            if ss.iloc[-1] > sl.iloc[-1]:
                score += 1; signals.append({"ind": "SMA", "sig": "BUY"})
            elif ss.iloc[-1] < sl.iloc[-1]:
                score -= 1; signals.append({"ind": "SMA", "sig": "SELL"})
            else:
                signals.append({"ind": "SMA", "sig": "HOLD"})

        ml = macd_line.dropna()
        ms = macd_signal.dropna()
        mh = macd_hist.dropna()
        if len(ml) and len(ms) and len(mh):
            if ml.iloc[-1] > ms.iloc[-1] and mh.iloc[-1] > 0:
                score += 1; signals.append({"ind": "MACD", "sig": "BUY"})
            elif ml.iloc[-1] < ms.iloc[-1] and mh.iloc[-1] < 0:
                score -= 1; signals.append({"ind": "MACD", "sig": "SELL"})
            else:
                signals.append({"ind": "MACD", "sig": "HOLD"})

        sk = stoch_k.dropna()
        sd = stoch_d.dropna()
        if len(sk) and len(sd):
            if sk.iloc[-1] < 20:
                score += 1; signals.append({"ind": "Stoch", "sig": "BUY"})
            elif sk.iloc[-1] > 80:
                score -= 1; signals.append({"ind": "Stoch", "sig": "SELL"})
            else:
                signals.append({"ind": "Stoch", "sig": "HOLD"})

        if score >= 2:
            action = "BUY"
        elif score <= -2:
            action = "SELL"
        else:
            action = "HOLD"

        closes = close.dropna().tolist()
        last_20 = closes[-20:] if len(closes) >= 20 else closes
        price = round(closes[-1], 2)
        prev = closes[-2] if len(closes) >= 2 else closes[-1]
        day_chg = round((price - prev) / prev * 100, 2) if prev else 0

        info = stock.info
        name = info.get("longName") or info.get("shortName") or symbol

        return {
            "symbol": symbol,
            "name": name,
            "price": price,
            "dayChange": day_chg,
            "action": action,
            "score": score,
            "signals": signals,
            "sparkline": [round(c, 2) for c in last_20],
        }
    except Exception:
        return None


def scan_market(tickers: list, market: str = "set") -> list:
    cache_key = f"{market}:{','.join(sorted(t.upper() for t in tickers))}"
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < CACHE_TTL:
        return cached["data"]

    symbols = [normalize_ticker(t, market) for t in tickers]

    results = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_compute_signal_fast, sym): sym for sym in symbols}
        for future in as_completed(futures):
            r = future.result()
            if r:
                results.append(r)

    results.sort(key=lambda x: (-x["score"], x["symbol"]))
    _cache[cache_key] = {"ts": time.time(), "data": results}
    return results


def scan_defaults(market: str = "set") -> list:
    tickers = DEFAULT_SCAN_SET if market == "set" else DEFAULT_SCAN_US
    return scan_market(tickers, market)
