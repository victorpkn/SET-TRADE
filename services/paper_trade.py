import time
import uuid
import logging
from services.yf_session import Ticker, yf_fetch_with_retry
from services.stock_data import normalize_ticker

logger = logging.getLogger(__name__)

DEFAULT_BALANCE = 100_000.0

_account = {
    "startingBalance": DEFAULT_BALANCE,
    "cash": DEFAULT_BALANCE,
    "positions": [],
    "history": [],
    "createdAt": time.time(),
}


def reset_account(starting_balance: float = DEFAULT_BALANCE):
    _account["startingBalance"] = starting_balance
    _account["cash"] = starting_balance
    _account["positions"] = []
    _account["history"] = []
    _account["createdAt"] = time.time()


def buy(ticker: str, market: str, shares: float) -> dict:
    symbol = normalize_ticker(ticker, market)
    price = _get_live_price(symbol)
    if price is None:
        return {"error": f"Could not fetch price for {ticker}"}

    cost = shares * price
    if cost > _account["cash"]:
        return {"error": f"Insufficient cash. Need ${cost:.2f}, have ${_account['cash']:.2f}"}

    _account["cash"] -= cost
    pos = {
        "id": uuid.uuid4().hex[:10],
        "ticker": ticker.upper(),
        "symbol": symbol,
        "market": market,
        "shares": shares,
        "entryPrice": round(price, 2),
        "entryTime": time.time(),
    }
    _account["positions"].append(pos)
    logger.info(f"Paper BUY: {shares} x {ticker} @ ${price:.2f}")
    return {"ok": True, "position": pos, "cash": round(_account["cash"], 2)}


def sell(position_id: str) -> dict:
    pos = None
    for p in _account["positions"]:
        if p["id"] == position_id:
            pos = p
            break
    if not pos:
        return {"error": "Position not found"}

    price = _get_live_price(pos["symbol"])
    if price is None:
        return {"error": f"Could not fetch price for {pos['ticker']}"}

    proceeds = pos["shares"] * price
    _account["cash"] += proceeds

    pnl = proceeds - (pos["shares"] * pos["entryPrice"])
    pnl_pct = (pnl / (pos["shares"] * pos["entryPrice"])) * 100

    trade = {
        "id": uuid.uuid4().hex[:10],
        "ticker": pos["ticker"],
        "market": pos["market"],
        "shares": pos["shares"],
        "entryPrice": pos["entryPrice"],
        "exitPrice": round(price, 2),
        "pnl": round(pnl, 2),
        "pnlPct": round(pnl_pct, 2),
        "entryTime": pos["entryTime"],
        "exitTime": time.time(),
        "result": "win" if pnl > 0 else "loss",
    }
    _account["history"].append(trade)
    _account["positions"] = [p for p in _account["positions"] if p["id"] != position_id]
    logger.info(f"Paper SELL: {pos['ticker']} — P&L ${pnl:.2f} ({pnl_pct:.1f}%)")
    return {"ok": True, "trade": trade, "cash": round(_account["cash"], 2)}


def get_portfolio() -> dict:
    positions = []
    total_value = 0
    for pos in _account["positions"]:
        price = _get_live_price(pos["symbol"])
        if price is None:
            price = pos["entryPrice"]
        value = pos["shares"] * price
        cost = pos["shares"] * pos["entryPrice"]
        pnl = value - cost
        pnl_pct = (pnl / cost * 100) if cost > 0 else 0
        total_value += value
        positions.append({
            **pos,
            "currentPrice": round(price, 2),
            "value": round(value, 2),
            "pnl": round(pnl, 2),
            "pnlPct": round(pnl_pct, 2),
        })

    total_portfolio = _account["cash"] + total_value
    total_return = total_portfolio - _account["startingBalance"]
    total_return_pct = (total_return / _account["startingBalance"]) * 100

    return {
        "cash": round(_account["cash"], 2),
        "startingBalance": _account["startingBalance"],
        "portfolioValue": round(total_portfolio, 2),
        "totalReturn": round(total_return, 2),
        "totalReturnPct": round(total_return_pct, 2),
        "positions": positions,
    }


def get_history() -> dict:
    trades = _account["history"]
    if not trades:
        return {"trades": [], "stats": _empty_stats()}

    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    total_pnl = sum(t["pnl"] for t in trades)

    return {
        "trades": trades,
        "stats": {
            "totalTrades": len(trades),
            "wins": len(wins),
            "losses": len(losses),
            "winRate": round(len(wins) / len(trades) * 100, 1) if trades else 0,
            "totalPnl": round(total_pnl, 2),
            "avgWin": round(sum(t["pnlPct"] for t in wins) / len(wins), 2) if wins else 0,
            "avgLoss": round(sum(t["pnlPct"] for t in losses) / len(losses), 2) if losses else 0,
        },
    }


def _empty_stats():
    return {"totalTrades": 0, "wins": 0, "losses": 0, "winRate": 0,
            "totalPnl": 0, "avgWin": 0, "avgLoss": 0}


def _get_live_price(symbol: str) -> float | None:
    try:
        stock = Ticker(symbol)
        df = yf_fetch_with_retry(lambda: stock.history(period="5d", interval="1d"))
        if df.empty:
            return None
        return float(df["Close"].iloc[-1])
    except Exception:
        return None
