import pandas as pd
from ta.trend import SMAIndicator, EMAIndicator, MACD
from ta.momentum import StochasticOscillator, RSIIndicator
from ta.volatility import BollingerBands


# Default EMA periods (TradingView style: short / medium / long / very long).
DEFAULT_EMA_PERIODS = (9, 21, 50, 200)


def _parse_ema_periods(raw, default=DEFAULT_EMA_PERIODS):
    """Accepts a list/tuple of ints, comma-separated str, or None."""
    if raw is None:
        return list(default)
    if isinstance(raw, (list, tuple)):
        out = []
        for v in raw:
            try:
                p = int(v)
                if 1 <= p <= 500:
                    out.append(p)
            except (TypeError, ValueError):
                continue
        return out or list(default)
    if isinstance(raw, str):
        return _parse_ema_periods([s.strip() for s in raw.split(",") if s.strip()], default)
    return list(default)


def compute_indicators(df: pd.DataFrame, params: dict = None) -> dict:
    if params is None:
        params = {}

    close = df["Close"]
    high = df["High"]
    low = df["Low"]
    volume = df["Volume"].astype(float).fillna(0) if "Volume" in df.columns else None

    # ── SMA ──
    sma_short_w = params.get("sma_short", 20)
    sma_long_w = params.get("sma_long", 50)
    sma_short = SMAIndicator(close=close, window=sma_short_w).sma_indicator()
    sma_long = SMAIndicator(close=close, window=sma_long_w).sma_indicator()

    # ── EMA (multi-period overlay) ──
    ema_periods = _parse_ema_periods(params.get("ema_periods"))
    ema_series = {p: EMAIndicator(close=close, window=p).ema_indicator() for p in ema_periods}

    # ── MACD ──
    macd_fast = params.get("macd_fast", 12)
    macd_slow = params.get("macd_slow", 26)
    macd_sign = params.get("macd_signal", 9)
    macd_obj = MACD(close=close, window_slow=macd_slow, window_fast=macd_fast, window_sign=macd_sign)
    macd_line = macd_obj.macd()
    macd_signal = macd_obj.macd_signal()
    macd_hist = macd_obj.macd_diff()

    # ── Stochastic ──
    stoch_k_w = params.get("stoch_k", 14)
    stoch_smooth = params.get("stoch_smooth", 3)
    stoch_obj = StochasticOscillator(
        high=high, low=low, close=close,
        window=stoch_k_w, smooth_window=stoch_smooth
    )
    stoch_k = stoch_obj.stoch()
    stoch_d = stoch_obj.stoch_signal()

    # ── Bollinger Bands ──
    bb_period = int(params.get("bb_period", 20))
    bb_std = float(params.get("bb_std", 2.0))
    bb_obj = BollingerBands(close=close, window=bb_period, window_dev=bb_std)
    bb_upper = bb_obj.bollinger_hband()
    bb_middle = bb_obj.bollinger_mavg()
    bb_lower = bb_obj.bollinger_lband()

    # ── RSI ──
    rsi_period = int(params.get("rsi_period", 14))
    rsi_series = RSIIndicator(close=close, window=rsi_period).rsi()

    # ── VWAP (rolling) ──
    # Use rolling VWAP so it works across multi-day periods. Daily session
    # VWAP would reset each day; rolling is more useful as a trend overlay.
    vwap_period = int(params.get("vwap_period", 20))
    typical_price = (high + low + close) / 3.0
    if volume is not None and (volume > 0).any():
        pv = typical_price * volume
        vwap_series = (
            pv.rolling(window=vwap_period, min_periods=1).sum()
            / volume.rolling(window=vwap_period, min_periods=1).sum()
        )
    else:
        vwap_series = pd.Series([float("nan")] * len(close), index=close.index)

    # Match the time format used by stock_data.py: unix seconds for intraday
    # rows (anything finer than 1 day), otherwise "YYYY-MM-DD" strings.
    has_intraday = bool((df["date"].dt.normalize() != df["date"]).any())
    if has_intraday:
        epoch = pd.Timestamp("1970-01-01")
        dates = [int(v) for v in ((df["date"] - epoch).dt.total_seconds()).astype("int64").tolist()]
    else:
        dates = df["date"].dt.strftime("%Y-%m-%d").tolist()

    def to_series(series, date_series, digits=4):
        result = []
        for d, v in zip(date_series, series):
            if pd.notna(v):
                result.append({"time": d, "value": round(float(v), digits)})
        return result

    def to_macd_series(macd_s, signal_s, hist_s, date_series):
        result = []
        for d, m, s, h in zip(date_series, macd_s, signal_s, hist_s):
            if pd.notna(m) and pd.notna(s) and pd.notna(h):
                result.append({
                    "time": d,
                    "macd": round(float(m), 4),
                    "signal": round(float(s), 4),
                    "histogram": round(float(h), 4),
                })
        return result

    def to_stoch_series(k_s, d_s, date_series):
        result = []
        for d, k, dv in zip(date_series, k_s, d_s):
            if pd.notna(k) and pd.notna(dv):
                result.append({
                    "time": d,
                    "k": round(float(k), 2),
                    "d": round(float(dv), 2),
                })
        return result

    return {
        "sma_short": to_series(sma_short, dates),
        "sma_long": to_series(sma_long, dates),
        "ema": {
            "periods": list(ema_periods),
            "series": {str(p): to_series(s, dates) for p, s in ema_series.items()},
        },
        "macd": to_macd_series(macd_line, macd_signal, macd_hist, dates),
        "stochastic": to_stoch_series(stoch_k, stoch_d, dates),
        "bb": {
            "period": bb_period,
            "std": bb_std,
            "upper": to_series(bb_upper, dates, 2),
            "middle": to_series(bb_middle, dates, 2),
            "lower": to_series(bb_lower, dates, 2),
        },
        "rsi": {
            "period": rsi_period,
            "series": to_series(rsi_series, dates, 2),
        },
        "vwap": {
            "period": vwap_period,
            "series": to_series(vwap_series, dates, 2),
        },
        "raw": {
            "sma_short": sma_short,
            "sma_long": sma_long,
            "macd_line": macd_line,
            "macd_signal": macd_signal,
            "macd_hist": macd_hist,
            "stoch_k": stoch_k,
            "stoch_d": stoch_d,
        },
    }
