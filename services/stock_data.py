import logging
import pandas as pd
from services.yf_session import Ticker, yf_fetch_with_retry, get_cached_info

logger = logging.getLogger(__name__)

VALID_PERIODS = {"1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"}
VALID_MARKETS = {"set", "us"}
VALID_INTERVALS = {"1m", "2m", "5m", "15m", "30m", "60m", "1h", "1d", "1wk", "1mo"}
REQUIRED_COLUMNS = {"Open", "High", "Low", "Close", "Volume"}
INTRADAY_INTERVALS = {"1m", "2m", "5m", "15m", "30m", "60m", "1h", "90m"}

# yfinance constraints: limit how far back we can pull each intraday interval.
# Maps an interval to its strongest allowed (period, fallback_period) tuple.
INTERVAL_PERIOD_CAP = {
    "1m":  ("5d",  "1d"),
    "2m":  ("5d",  "1d"),
    "5m":  ("1mo", "5d"),
    "15m": ("1mo", "5d"),
    "30m": ("1mo", "5d"),
    "60m": ("6mo", "3mo"),
    "1h":  ("6mo", "3mo"),
    "90m": ("1mo", "5d"),
}

# Order of "rank" so we can compare a requested period against a cap.
PERIOD_RANK = {"1d": 0, "5d": 1, "1mo": 2, "3mo": 3, "6mo": 4, "1y": 5, "2y": 6, "5y": 7}


def normalize_ticker(ticker: str, market: str = "set") -> str:
    ticker = ticker.strip().upper()
    if market == "set" and not ticker.endswith(".BK"):
        ticker += ".BK"
    return ticker


def _coerce_period_for_interval(period: str, interval: str) -> str:
    """For intraday intervals, yfinance limits how far back you can query.
    Downgrade the requested period to the largest allowed window.
    """
    if interval not in INTRADAY_INTERVALS:
        return period
    cap, _ = INTERVAL_PERIOD_CAP.get(interval, ("6mo", "3mo"))
    if PERIOD_RANK.get(period, 0) > PERIOD_RANK.get(cap, 0):
        return cap
    return period


def fetch_stock_data(
    ticker: str,
    period: str = "6mo",
    market: str = "set",
    interval: str = "1d",
) -> dict:
    if interval not in VALID_INTERVALS:
        interval = "1d"
    if period not in VALID_PERIODS:
        period = "6mo"
    if market not in VALID_MARKETS:
        market = "set"

    period = _coerce_period_for_interval(period, interval)
    intraday = interval in INTRADAY_INTERVALS

    symbol = normalize_ticker(ticker, market)
    stock = Ticker(symbol)
    df = yf_fetch_with_retry(lambda: stock.history(period=period, interval=interval))

    if df is None or df.empty:
        return {"error": f"No data found for {symbol}"}

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        logger.warning(f"fetch_stock_data({symbol}): missing columns {missing}")
        return {"error": f"Incomplete data for {symbol}"}

    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    if df.empty:
        return {"error": f"No valid price data for {symbol}"}

    df["Volume"] = df["Volume"].fillna(0)

    df.index = pd.to_datetime(df.index)
    df = df.reset_index()
    # yfinance reset_index column is called "Date" for daily and "Datetime" for intraday.
    rename_col = "Datetime" if "Datetime" in df.columns else "Date"
    df.rename(columns={rename_col: "date"}, inplace=True)

    if df["date"].dt.tz is not None:
        df["date"] = df["date"].dt.tz_localize(None)

    df = df.set_index("date", drop=False)

    try:
        info = get_cached_info(symbol)
        name = info.get("longName") or info.get("shortName") or symbol if info else symbol
    except Exception as e:
        logger.warning(f"fetch_stock_data({symbol}): info lookup failed: {e}")
        name = symbol

    epoch = pd.Timestamp("1970-01-01")

    candles = []
    for _, row in df.iterrows():
        if intraday:
            # Use unix seconds (treating market-local naive time as UTC so the
            # chart axis reads back as market wall-clock without a tz shift).
            t_val = int((row["date"] - epoch).total_seconds())
        else:
            t_val = row["date"].strftime("%Y-%m-%d")
        candles.append({
            "time": t_val,
            "open": round(float(row["Open"]), 4),
            "high": round(float(row["High"]), 4),
            "low": round(float(row["Low"]), 4),
            "close": round(float(row["Close"]), 4),
            "volume": int(row["Volume"]),
        })

    return {
        "ticker": symbol,
        "name": name,
        "candles": candles,
        "interval": interval,
        "period": period,
        "intraday": intraday,
        "df": df,
    }
