import math
from services.yf_session import Ticker


def fetch_dcf(ticker: str, market: str = "set", overrides: dict = None) -> dict:
    if overrides is None:
        overrides = {}

    symbol = ticker.strip().upper()
    if market == "set" and not symbol.endswith(".BK"):
        symbol += ".BK"

    stock = Ticker(symbol)
    info = stock.info
    if not info or info.get("quoteType") is None:
        return {"error": f"No data found for {symbol}"}

    cf = stock.cashflow
    if cf is None or cf.empty or "Free Cash Flow" not in cf.index:
        return {"error": f"No cash flow data available for {symbol}"}

    fcf_row = cf.loc["Free Cash Flow"].dropna().sort_index()
    if len(fcf_row) < 2:
        return {"error": f"Not enough cash flow history for {symbol}"}

    fcf_values = fcf_row.values.tolist()
    fcf_years = [d.strftime("%Y") for d in fcf_row.index]
    latest_fcf = fcf_values[-1]

    first_positive = next((v for v in fcf_values if v > 0), None)
    last_positive = latest_fcf if latest_fcf > 0 else None
    n_years = len(fcf_values) - 1

    if first_positive and last_positive and n_years > 0 and first_positive != last_positive:
        avg_growth = (last_positive / first_positive) ** (1 / n_years) - 1
    else:
        avg_growth = 0.05

    avg_growth = max(-0.20, min(avg_growth, 0.25))

    shares = info.get("sharesOutstanding")
    total_debt = info.get("totalDebt") or 0
    total_cash = info.get("totalCash") or 0
    current_price = info.get("currentPrice") or info.get("regularMarketPrice")
    currency = info.get("currency", "")

    if not shares or not current_price:
        return {"error": f"Missing share/price data for {symbol}"}

    growth_rate = overrides.get("growth_rate", round(avg_growth * 100, 1)) / 100
    discount_rate = overrides.get("discount_rate", 10.0) / 100
    terminal_growth = overrides.get("terminal_growth", 2.5) / 100
    projection_years = int(overrides.get("projection_years", 5))
    projection_years = max(3, min(projection_years, 10))

    projections = []
    cumulative_pv = 0
    for yr in range(1, projection_years + 1):
        projected_fcf = latest_fcf * ((1 + growth_rate) ** yr)
        pv = projected_fcf / ((1 + discount_rate) ** yr)
        cumulative_pv += pv
        projections.append({
            "year": yr,
            "fcf": round(projected_fcf),
            "pv": round(pv),
        })

    last_projected_fcf = projections[-1]["fcf"]
    if discount_rate <= terminal_growth:
        terminal_value = last_projected_fcf * 20
    else:
        terminal_value = (last_projected_fcf * (1 + terminal_growth)) / (discount_rate - terminal_growth)
    pv_terminal = terminal_value / ((1 + discount_rate) ** projection_years)

    enterprise_value = cumulative_pv + pv_terminal
    equity_value = enterprise_value - total_debt + total_cash
    intrinsic_per_share = equity_value / shares

    upside = ((intrinsic_per_share - current_price) / current_price) * 100

    def fmt_large(v):
        av = abs(v)
        if av >= 1e12:
            return f"{v / 1e12:.2f}T"
        if av >= 1e9:
            return f"{v / 1e9:.2f}B"
        if av >= 1e6:
            return f"{v / 1e6:.1f}M"
        return f"{v:,.0f}"

    def _calc_intrinsic(gr, dr, tg, yrs):
        cpv = 0
        for yr in range(1, yrs + 1):
            pf = latest_fcf * ((1 + gr) ** yr)
            cpv += pf / ((1 + dr) ** yr)
        lpf = latest_fcf * ((1 + gr) ** yrs)
        if dr <= tg:
            tv = lpf * 20
        else:
            tv = (lpf * (1 + tg)) / (dr - tg)
        pvt = tv / ((1 + dr) ** yrs)
        ev = cpv + pvt
        eq = ev - total_debt + total_cash
        return round(eq / shares, 2)

    growth_steps = [round(growth_rate * 100 + d, 1) for d in [-4, -2, 0, 2, 4]]
    discount_steps = [round(discount_rate * 100 + d, 1) for d in [-2, -1, 0, 1, 2]]
    discount_steps = [d for d in discount_steps if d > 0]

    sensitivity_table = []
    for gr_pct in growth_steps:
        row_vals = []
        row_discounts = []
        for dr_pct in discount_steps:
            iv = _calc_intrinsic(gr_pct / 100, dr_pct / 100, terminal_growth, projection_years)
            row_vals.append(iv)
            row_discounts.append(dr_pct)
        sensitivity_table.append({
            "growth": gr_pct,
            "discounts": row_discounts,
            "values": row_vals,
        })

    return {
        "ticker": symbol,
        "currency": currency,
        "currentPrice": round(current_price, 2),
        "intrinsicValue": round(intrinsic_per_share, 2),
        "upside": round(upside, 1),
        "assumptions": {
            "growthRate": round(growth_rate * 100, 1),
            "discountRate": round(discount_rate * 100, 1),
            "terminalGrowth": round(terminal_growth * 100, 1),
            "projectionYears": projection_years,
        },
        "projections": projections,
        "sensitivityTable": sensitivity_table,
        "breakdown": {
            "pvFcf": fmt_large(round(cumulative_pv)),
            "pvTerminal": fmt_large(round(pv_terminal)),
            "enterpriseValue": fmt_large(round(enterprise_value)),
            "totalDebt": fmt_large(round(total_debt)),
            "totalCash": fmt_large(round(total_cash)),
            "equityValue": fmt_large(round(equity_value)),
            "sharesOutstanding": fmt_large(shares),
        },
        "history": {
            "years": fcf_years,
            "fcf": [round(v) for v in fcf_values],
            "avgGrowth": round(avg_growth * 100, 1),
        },
    }
