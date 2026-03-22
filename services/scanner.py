import time
import logging
import pandas as pd
from services.yf_session import Ticker
from concurrent.futures import ThreadPoolExecutor, as_completed
from ta.trend import SMAIndicator, MACD
from ta.momentum import StochasticOscillator
from services.stock_data import normalize_ticker

logger = logging.getLogger(__name__)

_cache = {}
CACHE_TTL = 1800  # 30 minutes

DEFAULT_SCAN_SET = [
    "PTT", "AOT", "CPALL", "KBANK", "ADVANC", "GULF", "BDMS",
    "DELTA", "SCC", "BBL", "CPN", "MINT", "BH", "IVL",
]

DEFAULT_SCAN_US = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM",
    "V", "UNH", "HD", "PG", "NFLX", "DIS",
]


def _yf_retry(fn, retries=2, delay=3):
    """Call fn with retry on rate limit errors."""
    for attempt in range(retries + 1):
        try:
            return fn()
        except Exception as e:
            if "Rate" in str(e) or "429" in str(e) or "Too Many" in str(e):
                if attempt < retries:
                    logger.warning(f"Rate limited, retrying in {delay}s (attempt {attempt + 1})")
                    time.sleep(delay * (attempt + 1))
                    continue
            raise


def _compute_signal_fast(symbol: str) -> dict | None:
    """Compute signals for a single ticker. Returns None on failure."""
    try:
        stock = Ticker(symbol)
        df = _yf_retry(lambda: stock.history(period="3mo", interval="1d"))
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
        sector = info.get("sector") or "Other"

        return {
            "symbol": symbol,
            "name": name,
            "sector": sector,
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
    with ThreadPoolExecutor(max_workers=4) as pool:
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


def compute_signal_accuracy(symbol: str, lookback_days: int = 90,
                            horizon: int = 5) -> dict | None:
    """Check historical signal accuracy: did price move in the predicted direction?"""
    try:
        stock = Ticker(symbol)
        df = _yf_retry(lambda: stock.history(period="1y", interval="1d"))
        if df.empty or len(df) < 60:
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

        closes = close.values
        n = len(closes)
        start_idx = max(50, n - lookback_days)

        buy_correct = 0
        buy_total = 0
        sell_correct = 0
        sell_total = 0
        signals_log = []

        for i in range(start_idx, n - horizon):
            sc = 0
            ss_v = sma_s.iloc[i] if pd.notna(sma_s.iloc[i]) else None
            sl_v = sma_l.iloc[i] if pd.notna(sma_l.iloc[i]) else None
            if ss_v is not None and sl_v is not None:
                sc += 1 if ss_v > sl_v else (-1 if ss_v < sl_v else 0)

            ml_v = macd_line.iloc[i] if pd.notna(macd_line.iloc[i]) else None
            ms_v = macd_signal.iloc[i] if pd.notna(macd_signal.iloc[i]) else None
            mh_v = macd_hist.iloc[i] if pd.notna(macd_hist.iloc[i]) else None
            if ml_v is not None and ms_v is not None and mh_v is not None:
                if ml_v > ms_v and mh_v > 0:
                    sc += 1
                elif ml_v < ms_v and mh_v < 0:
                    sc -= 1

            sk_v = stoch_k.iloc[i] if pd.notna(stoch_k.iloc[i]) else None
            if sk_v is not None:
                if sk_v < 20:
                    sc += 1
                elif sk_v > 80:
                    sc -= 1

            if sc >= 2:
                action = "BUY"
            elif sc <= -2:
                action = "SELL"
            else:
                continue

            future_price = closes[i + horizon]
            entry_price = closes[i]
            pct_move = (future_price - entry_price) / entry_price * 100

            correct = (action == "BUY" and pct_move > 0) or (action == "SELL" and pct_move < 0)

            if action == "BUY":
                buy_total += 1
                if correct:
                    buy_correct += 1
            else:
                sell_total += 1
                if correct:
                    sell_correct += 1

            dt = df.index[i]
            date_str = dt.strftime("%Y-%m-%d") if hasattr(dt, 'strftime') else str(dt)
            signals_log.append({
                "date": date_str,
                "action": action,
                "price": round(float(entry_price), 2),
                "futurePrice": round(float(future_price), 2),
                "pctMove": round(float(pct_move), 2),
                "correct": correct,
            })

        total = buy_total + sell_total
        total_correct = buy_correct + sell_correct

        return {
            "symbol": symbol,
            "horizon": horizon,
            "lookbackDays": lookback_days,
            "totalSignals": total,
            "totalCorrect": total_correct,
            "overallAccuracy": round(total_correct / total * 100, 1) if total else 0,
            "buySignals": buy_total,
            "buyCorrect": buy_correct,
            "buyAccuracy": round(buy_correct / buy_total * 100, 1) if buy_total else 0,
            "sellSignals": sell_total,
            "sellCorrect": sell_correct,
            "sellAccuracy": round(sell_correct / sell_total * 100, 1) if sell_total else 0,
            "recentSignals": signals_log[-20:],
        }
    except Exception:
        return None


def compute_market_accuracy(market: str = "set", horizon: int = 5) -> dict:
    """Aggregate signal accuracy across default tickers."""
    cache_key = f"accuracy:{market}:{horizon}"
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < CACHE_TTL:
        return cached["data"]

    tickers = DEFAULT_SCAN_SET if market == "set" else DEFAULT_SCAN_US
    symbols = [normalize_ticker(t, market) for t in tickers]

    results = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(compute_signal_accuracy, sym, 90, horizon): sym for sym in symbols}
        for future in as_completed(futures):
            r = future.result()
            if r:
                results.append(r)

    total_signals = sum(r["totalSignals"] for r in results)
    total_correct = sum(r["totalCorrect"] for r in results)
    buy_total = sum(r["buySignals"] for r in results)
    buy_correct = sum(r["buyCorrect"] for r in results)
    sell_total = sum(r["sellSignals"] for r in results)
    sell_correct = sum(r["sellCorrect"] for r in results)

    data = {
        "market": market,
        "horizon": horizon,
        "stocksAnalyzed": len(results),
        "totalSignals": total_signals,
        "overallAccuracy": round(total_correct / total_signals * 100, 1) if total_signals else 0,
        "buyAccuracy": round(buy_correct / buy_total * 100, 1) if buy_total else 0,
        "sellAccuracy": round(sell_correct / sell_total * 100, 1) if sell_total else 0,
        "buySignals": buy_total,
        "sellSignals": sell_total,
        "perStock": sorted(
            [{"symbol": r["symbol"].replace(".BK", ""), "accuracy": r["overallAccuracy"],
              "total": r["totalSignals"], "buyAcc": r["buyAccuracy"], "sellAcc": r["sellAccuracy"]}
             for r in results],
            key=lambda x: -x["accuracy"]
        ),
    }

    _cache[cache_key] = {"ts": time.time(), "data": data}
    return data
