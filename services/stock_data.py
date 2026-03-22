import time
import logging
import pandas as pd
from services.yf_session import Ticker

logger = logging.getLogger(__name__)

VALID_PERIODS = {"1mo", "3mo", "6mo", "1y", "2y", "5y"}
VALID_MARKETS = {"set", "us"}


def _yf_retry(fn, retries=2, delay=3):
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


def normalize_ticker(ticker: str, market: str = "set") -> str:
    ticker = ticker.strip().upper()
    if market == "set" and not ticker.endswith(".BK"):
        ticker += ".BK"
    return ticker


def fetch_stock_data(ticker: str, period: str = "6mo", market: str = "set") -> dict:
    if period not in VALID_PERIODS:
        period = "6mo"
    if market not in VALID_MARKETS:
        market = "set"

    symbol = normalize_ticker(ticker, market)
    stock = Ticker(symbol)
    df = _yf_retry(lambda: stock.history(period=period, interval="1d"))

    if df.empty:
        return {"error": f"No data found for {symbol}"}

    df.index = pd.to_datetime(df.index)
    df = df.reset_index()
    df.rename(columns={"Date": "date"}, inplace=True)

    if df["date"].dt.tz is not None:
        df["date"] = df["date"].dt.tz_localize(None)

    df = df.set_index("date", drop=False)

    info = stock.info
    name = info.get("longName") or info.get("shortName") or symbol

    candles = []
    for _, row in df.iterrows():
        candles.append({
            "time": row["date"].strftime("%Y-%m-%d"),
            "open": round(row["Open"], 2),
            "high": round(row["High"], 2),
            "low": round(row["Low"], 2),
            "close": round(row["Close"], 2),
            "volume": int(row["Volume"]),
        })

    return {
        "ticker": symbol,
        "name": name,
        "candles": candles,
        "df": df,
    }
