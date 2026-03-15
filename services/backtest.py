import math
import pandas as pd
from services.stock_data import fetch_stock_data
from services.technical import compute_indicators


def run_backtest(ticker: str, market: str, period: str,
                 params: dict, active_indicators: list) -> dict:
    data = fetch_stock_data(ticker, period, market)
    if "error" in data:
        return data

    df = data.pop("df")
    indicators = compute_indicators(df, params)
    raw = indicators["raw"]

    close = df["Close"]
    dates = df["date"].dt.strftime("%Y-%m-%d").tolist()

    day_signals = _compute_daily_signals(raw, close, params, active_indicators)

    trades, equity_curve, buy_hold_curve = _simulate(
        close.values.tolist(), dates, day_signals
    )

    metrics = _compute_metrics(trades, equity_curve, buy_hold_curve, close.values.tolist())

    return {
        "ticker": data.get("ticker", ticker),
        "name": data.get("name", ticker),
        "period": period,
        "activeIndicators": active_indicators,
        "trades": trades,
        "metrics": metrics,
        "equityCurve": equity_curve,
        "buyHoldCurve": buy_hold_curve,
    }


def _compute_daily_signals(raw, close, params, active):
    sma_short = raw["sma_short"]
    sma_long = raw["sma_long"]
    macd_line = raw["macd_line"]
    macd_signal = raw["macd_signal"]
    macd_hist = raw["macd_hist"]
    stoch_k = raw["stoch_k"]
    stoch_d = raw["stoch_d"]
    stoch_ob = params.get("stoch_ob", 80)
    stoch_os = params.get("stoch_os", 20)

    n = len(close)
    signals = []

    for i in range(n):
        score = 0
        count = 0

        if "sma" in active:
            ss = sma_short.iloc[i] if i < len(sma_short) else None
            sl = sma_long.iloc[i] if i < len(sma_long) else None
            if pd.notna(ss) and pd.notna(sl):
                count += 1
                if ss > sl:
                    score += 1
                elif ss < sl:
                    score -= 1

        if "macd" in active:
            ml = macd_line.iloc[i] if i < len(macd_line) else None
            ms = macd_signal.iloc[i] if i < len(macd_signal) else None
            mh = macd_hist.iloc[i] if i < len(macd_hist) else None
            if pd.notna(ml) and pd.notna(ms) and pd.notna(mh):
                count += 1
                if ml > ms and mh > 0:
                    score += 1
                elif ml < ms and mh < 0:
                    score -= 1

        if "stochastic" in active:
            sk = stoch_k.iloc[i] if i < len(stoch_k) else None
            sd = stoch_d.iloc[i] if i < len(stoch_d) else None
            if pd.notna(sk) and pd.notna(sd):
                count += 1
                if sk < stoch_os:
                    score += 1
                elif sk > stoch_ob:
                    score -= 1

        if count == 0:
            signals.append("HOLD")
        elif score >= 2:
            signals.append("BUY")
        elif score <= -2:
            signals.append("SELL")
        else:
            signals.append("HOLD")

    return signals


def _simulate(prices, dates, signals):
    trades = []
    equity_curve = []
    buy_hold_curve = []

    initial_price = prices[0] if prices else 1
    in_position = False
    entry_price = 0
    entry_date = ""
    entry_idx = 0
    cumulative_return = 0.0

    for i, (price, date, sig) in enumerate(zip(prices, dates, signals)):
        bh_return = ((price - initial_price) / initial_price) * 100
        buy_hold_curve.append({"time": date, "value": round(bh_return, 2)})

        if sig == "BUY" and not in_position:
            in_position = True
            entry_price = price
            entry_date = date
            entry_idx = i

        elif sig == "SELL" and in_position:
            pnl_pct = ((price - entry_price) / entry_price) * 100
            cumulative_return += pnl_pct
            trades.append({
                "entryDate": entry_date,
                "exitDate": date,
                "entryPrice": round(entry_price, 2),
                "exitPrice": round(price, 2),
                "pnlPct": round(pnl_pct, 2),
                "holdDays": i - entry_idx,
                "result": "win" if pnl_pct > 0 else "loss",
            })
            in_position = False

        equity_curve.append({"time": date, "value": round(cumulative_return, 2)})

    if in_position and prices:
        pnl_pct = ((prices[-1] - entry_price) / entry_price) * 100
        trades.append({
            "entryDate": entry_date,
            "exitDate": dates[-1],
            "entryPrice": round(entry_price, 2),
            "exitPrice": round(prices[-1], 2),
            "pnlPct": round(pnl_pct, 2),
            "holdDays": len(prices) - 1 - entry_idx,
            "result": "open",
        })

    return trades, equity_curve, buy_hold_curve


def _compute_metrics(trades, equity_curve, buy_hold_curve, prices):
    if not trades:
        return _empty_metrics()

    closed_trades = [t for t in trades if t["result"] != "open"]
    wins = [t for t in closed_trades if t["pnlPct"] > 0]
    losses = [t for t in closed_trades if t["pnlPct"] <= 0]

    total_return = equity_curve[-1]["value"] if equity_curve else 0
    buy_hold_return = buy_hold_curve[-1]["value"] if buy_hold_curve else 0
    num_trades = len(closed_trades)
    win_rate = (len(wins) / num_trades * 100) if num_trades > 0 else 0
    avg_win = (sum(t["pnlPct"] for t in wins) / len(wins)) if wins else 0
    avg_loss = (sum(t["pnlPct"] for t in losses) / len(losses)) if losses else 0
    gross_wins = sum(t["pnlPct"] for t in wins) if wins else 0
    gross_losses = abs(sum(t["pnlPct"] for t in losses)) if losses else 0
    profit_factor = (gross_wins / gross_losses) if gross_losses > 0 else float("inf") if gross_wins > 0 else 0
    avg_hold_days = (sum(t["holdDays"] for t in closed_trades) / num_trades) if num_trades > 0 else 0

    eq_vals = [p["value"] for p in equity_curve]
    max_dd = _max_drawdown(eq_vals)

    trading_days = len(prices)
    years = trading_days / 252 if trading_days > 0 else 1
    sharpe = _sharpe_ratio(eq_vals, years)

    return {
        "totalReturn": round(total_return, 2),
        "buyHoldReturn": round(buy_hold_return, 2),
        "numTrades": num_trades,
        "numWins": len(wins),
        "numLosses": len(losses),
        "winRate": round(win_rate, 1),
        "avgWin": round(avg_win, 2),
        "avgLoss": round(avg_loss, 2),
        "maxDrawdown": round(max_dd, 2),
        "sharpe": round(sharpe, 2),
        "profitFactor": round(profit_factor, 2) if profit_factor != float("inf") else 999,
        "avgHoldDays": round(avg_hold_days, 1),
        "outperformance": round(total_return - buy_hold_return, 2),
    }


def _max_drawdown(eq_vals):
    if not eq_vals:
        return 0
    peak = eq_vals[0]
    max_dd = 0
    for v in eq_vals:
        if v > peak:
            peak = v
        dd = peak - v
        if dd > max_dd:
            max_dd = dd
    return max_dd


def _sharpe_ratio(eq_vals, years, risk_free_annual=0.04):
    if len(eq_vals) < 2:
        return 0
    daily_returns = []
    for i in range(1, len(eq_vals)):
        daily_returns.append(eq_vals[i] - eq_vals[i - 1])

    if not daily_returns:
        return 0

    mean_r = sum(daily_returns) / len(daily_returns)
    std_r = (sum((r - mean_r) ** 2 for r in daily_returns) / len(daily_returns)) ** 0.5

    if std_r == 0:
        return 0

    daily_rf = risk_free_annual / 252
    sharpe = (mean_r - daily_rf) / std_r * math.sqrt(252)
    return sharpe


def _empty_metrics():
    return {
        "totalReturn": 0,
        "buyHoldReturn": 0,
        "numTrades": 0,
        "numWins": 0,
        "numLosses": 0,
        "winRate": 0,
        "avgWin": 0,
        "avgLoss": 0,
        "maxDrawdown": 0,
        "sharpe": 0,
        "profitFactor": 0,
        "avgHoldDays": 0,
        "outperformance": 0,
    }
