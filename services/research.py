"""
Research module — Buffett-style qualitative analysis for a single ticker.

Returns three scores (Moat, Management, Margin of Safety) plus the raw business
context needed to answer Buffett's four questions:
    1. Understand the business           → overview + officers
    2. Look for a competitive advantage   → moat score (6 components)
    3. Check the management team          → management score (5 components)
    4. Valuation and margin of safety     → value checks (DCF + Owner Earnings + Graham)
"""
import logging
import math
import statistics
from datetime import datetime, timedelta, timezone

import pandas as pd

from services.yf_session import (
    get_cached_info,
    get_cached_financials,
    get_cached_insider_txns,
    invalidate_cache,
)
from services.industry import fetch_industry_medians
from services.valuation import fetch_dcf

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# yfinance row name resolution — names vary across versions, so try synonyms.
# ─────────────────────────────────────────────────────────────────────────────

ROW_SYNONYMS = {
    "revenue":          ["Total Revenue", "Revenue", "TotalRevenue"],
    "gross_profit":     ["Gross Profit", "GrossProfit"],
    "operating_income": ["Operating Income", "OperatingIncome", "Operating Revenue"],
    "net_income":       ["Net Income", "NetIncome", "Net Income Common Stockholders"],
    "ebitda":           ["EBITDA", "Normalized EBITDA"],
    "interest_expense": ["Interest Expense", "InterestExpense", "Interest Expense Non Operating"],
    "rd_expense":       ["Research And Development", "Research Development", "ResearchAndDevelopment"],
    "total_assets":     ["Total Assets", "TotalAssets"],
    "total_equity":     ["Stockholders Equity", "Total Stockholder Equity", "StockholdersEquity", "Common Stock Equity"],
    "total_debt":       ["Total Debt", "TotalDebt", "Net Debt"],
    "intangibles":      ["Goodwill And Other Intangible Assets", "Goodwill", "Other Intangible Assets", "Intangible Assets"],
    "shares":           ["Share Issued", "Ordinary Shares Number", "Common Stock Shares Outstanding"],
    "retained_earnings": ["Retained Earnings", "RetainedEarnings"],
    "fcf":              ["Free Cash Flow", "FreeCashFlow"],
    "depreciation":     ["Depreciation And Amortization", "Depreciation Amortization Depletion", "Depreciation"],
    "capex":            ["Capital Expenditure", "CapitalExpenditure", "Capital Expenditures"],
    "dividends_paid":   ["Cash Dividends Paid", "CashDividendsPaid", "Common Stock Dividend Paid"],
}


def _get_row(df, key):
    """Return a row from a yfinance statement DataFrame, trying multiple names.

    Returns a pandas Series sorted by date (oldest → newest) or None if missing.
    """
    if df is None or df.empty:
        return None
    for name in ROW_SYNONYMS.get(key, []):
        if name in df.index:
            row = df.loc[name].dropna()
            if not row.empty:
                return row.sort_index()
    return None


def _series_values(row):
    """Return the numeric values of a row, newest last. Returns [] if missing."""
    if row is None or row.empty:
        return []
    return [float(v) for v in row.values if pd.notna(v)]


def _safe_div(a, b):
    if a is None or b is None or b == 0:
        return None
    return a / b


def _cagr(values):
    """Compound annual growth rate over a series. Needs ≥2 positive endpoints."""
    if len(values) < 2:
        return None
    first, last = values[0], values[-1]
    n = len(values) - 1
    if first <= 0 or last <= 0 or n <= 0:
        return None
    return (last / first) ** (1 / n) - 1


def _mean(values):
    return statistics.fmean(values) if values else None


def _stdev(values):
    return statistics.pstdev(values) if len(values) >= 2 else None


def _linear_slope(values):
    """Linear regression slope — positive means trend is improving."""
    n = len(values)
    if n < 2:
        return None
    xs = list(range(n))
    mean_x = sum(xs) / n
    mean_y = sum(values) / n
    num = sum((xs[i] - mean_x) * (values[i] - mean_y) for i in range(n))
    den = sum((xs[i] - mean_x) ** 2 for i in range(n))
    return num / den if den else None


def _clamp(v, lo=0, hi=100):
    return max(lo, min(hi, v))


def _verdict_for_score(score):
    if score >= 70:
        return "good"
    if score >= 40:
        return "neutral"
    return "bad"


def _grade_moat(score):
    if score >= 80:
        return "Wide"
    if score >= 50:
        return "Narrow"
    return "None"


def _grade_management(score):
    if score >= 85:
        return "A"
    if score >= 70:
        return "B"
    if score >= 50:
        return "C"
    return "D"


# ─────────────────────────────────────────────────────────────────────────────
# Moat scoring
# ─────────────────────────────────────────────────────────────────────────────

def _score_profitability(financials, info, industry_medians):
    """5y ROE level + stability + vs-industry adjustment."""
    net_income = _series_values(_get_row(financials, "net_income"))
    equity = _series_values(_get_row(financials, "total_equity"))
    roe_series = []
    for i in range(min(len(net_income), len(equity))):
        if equity[i] > 0:
            roe_series.append(net_income[i] / equity[i])
    if not roe_series:
        ttm = info.get("returnOnEquity")
        if ttm is None:
            return None, "Insufficient data"
        roe_series = [ttm]

    avg_roe = _mean(roe_series)
    if avg_roe >= 0.20:
        base = 100
    elif avg_roe >= 0.15:
        base = 85
    elif avg_roe >= 0.10:
        base = 65
    elif avg_roe >= 0.05:
        base = 35
    else:
        base = max(0, 30 + avg_roe * 100)

    sd = _stdev(roe_series)
    if sd is not None and sd < 0.05 and len(roe_series) >= 3:
        base += 10

    ind_roe = industry_medians.get("returnOnEquity") if industry_medians else None
    if ind_roe is not None and ind_roe != 0:
        diff = (avg_roe - ind_roe) / abs(ind_roe)
        if diff > 0.20:
            base += 8
        elif diff < -0.20:
            base -= 8

    detail = f"5y avg ROE {avg_roe * 100:.1f}%"
    if sd is not None and len(roe_series) >= 3:
        detail += f" · stability ±{sd * 100:.1f}pp"
    return _clamp(base), detail


def _score_margins(financials, info, industry_medians):
    """Gross + operating margin: level relative to industry, plus trend."""
    revenue = _series_values(_get_row(financials, "revenue"))
    gross = _series_values(_get_row(financials, "gross_profit"))
    op_income = _series_values(_get_row(financials, "operating_income"))

    gross_margins = []
    for i in range(min(len(revenue), len(gross))):
        if revenue[i] > 0:
            gross_margins.append(gross[i] / revenue[i])

    op_margins = []
    for i in range(min(len(revenue), len(op_income))):
        if revenue[i] > 0:
            op_margins.append(op_income[i] / revenue[i])

    if not gross_margins and not op_margins:
        ttm = info.get("grossMargins") or info.get("operatingMargins")
        if ttm is None:
            return None, "Insufficient data"
        gross_margins = [ttm]

    avg_gm = _mean(gross_margins) if gross_margins else None
    avg_om = _mean(op_margins) if op_margins else info.get("operatingMargins")

    if avg_gm is not None:
        if avg_gm >= 0.50:
            base = 95
        elif avg_gm >= 0.35:
            base = 80
        elif avg_gm >= 0.20:
            base = 55
        elif avg_gm >= 0.10:
            base = 30
        else:
            base = 10
    else:
        base = 50

    ind_om = industry_medians.get("operatingMargins") if industry_medians else None
    if ind_om is not None and avg_om is not None and ind_om != 0:
        diff = (avg_om - ind_om) / abs(ind_om)
        if diff > 0.20:
            base += 8
        elif diff < -0.20:
            base -= 8

    if op_margins and len(op_margins) >= 3:
        slope = _linear_slope(op_margins)
        if slope is not None:
            if slope < -0.005:
                base -= 15
            elif slope > 0.005:
                base += 8

    parts = []
    if avg_gm is not None:
        parts.append(f"Gross {avg_gm * 100:.1f}%")
    if avg_om is not None:
        parts.append(f"Op {avg_om * 100:.1f}%")
    return _clamp(base), " · ".join(parts) if parts else "Limited data"


def _score_capital_efficiency(financials, cashflow, info):
    """FCF margin — how much real cash comes out of every dollar of sales."""
    revenue = _series_values(_get_row(financials, "revenue"))
    fcf = _series_values(_get_row(cashflow, "fcf"))
    if not fcf:
        ni = _series_values(_get_row(financials, "net_income"))
        da = _series_values(_get_row(cashflow, "depreciation"))
        capex = _series_values(_get_row(cashflow, "capex"))
        n = min(len(ni), len(da), len(capex)) if (ni and da and capex) else 0
        # CapEx may be signed either way across yfinance versions — normalize as an outflow.
        fcf = [ni[i] + da[i] - abs(capex[i]) for i in range(n)]

    fcf_margins = []
    for i in range(min(len(revenue), len(fcf))):
        if revenue[i] > 0:
            fcf_margins.append(fcf[i] / revenue[i])

    if not fcf_margins:
        return None, "No FCF data"

    avg = _mean(fcf_margins)
    if avg >= 0.20:
        base = 100
    elif avg >= 0.10:
        base = 75
    elif avg >= 0.05:
        base = 55
    elif avg > 0:
        base = 35
    else:
        base = 10

    return _clamp(base), f"5y avg FCF margin {avg * 100:.1f}%"


def _score_reinvestment(financials, info):
    """Revenue CAGR × ROE multiplier — finds true compounders."""
    revenue = _series_values(_get_row(financials, "revenue"))
    if len(revenue) < 3:
        rg = info.get("revenueGrowth")
        if rg is None:
            return None, "Insufficient history"
        cagr = rg
    else:
        cagr = _cagr(revenue)
        if cagr is None:
            return None, "Negative revenue"

    roe_ttm = info.get("returnOnEquity") or 0
    multiplier = 1.5 if roe_ttm > 0.15 else 1.0

    score = cagr * 100 * multiplier
    base = _clamp(score, 0, 100)

    label = "compounder" if multiplier > 1 else "growth only"
    return base, f"Revenue CAGR {cagr * 100:.1f}% · {label}"


def _score_intangibles(balance_sheet, info):
    """Intangibles / assets as a proxy for brand & IP moat."""
    assets = _series_values(_get_row(balance_sheet, "total_assets"))
    intangibles = _series_values(_get_row(balance_sheet, "intangibles"))
    if not assets:
        return None, "No balance sheet data"
    latest_assets = assets[-1]
    latest_intang = intangibles[-1] if intangibles else 0
    ratio = latest_intang / latest_assets if latest_assets else 0

    roic_proxy = info.get("returnOnEquity") or 0

    if ratio >= 0.30 and roic_proxy > 0.15:
        base = 100
    elif ratio >= 0.30:
        base = 70
    elif ratio >= 0.15:
        base = 55
    elif ratio >= 0.05:
        base = 35
    else:
        base = 50 if roic_proxy > 0.20 else 25

    return _clamp(base), f"Intangibles {ratio * 100:.1f}% of assets"


def _score_fortress(balance_sheet, financials, info):
    """Balance-sheet strength — net debt / EBITDA + interest coverage."""
    debt = info.get("totalDebt") or 0
    cash = info.get("totalCash") or 0
    net_debt = debt - cash

    ebitda = info.get("ebitda")
    if ebitda is None:
        ebitda_series = _series_values(_get_row(financials, "ebitda"))
        ebitda = ebitda_series[-1] if ebitda_series else None

    if ebitda is None or ebitda <= 0:
        if net_debt <= 0:
            return 90, "Net cash position"
        return 30, "No EBITDA data"

    nd_ratio = net_debt / ebitda
    if nd_ratio < 0:
        base = 100
    elif nd_ratio < 1:
        base = 85
    elif nd_ratio < 3:
        base = 60
    elif nd_ratio < 5:
        base = 30
    else:
        base = 10

    op_income = _series_values(_get_row(financials, "operating_income"))
    interest = _series_values(_get_row(financials, "interest_expense"))
    if op_income and interest and interest[-1] > 0:
        coverage = op_income[-1] / interest[-1]
        if coverage > 10:
            base += 10
        elif coverage < 3:
            base -= 15

    return _clamp(base), f"Net debt / EBITDA {nd_ratio:.1f}×"


def _compute_moat(financials, balance_sheet, cashflow, info, industry_medians):
    components_spec = [
        ("profitability", "Profitability Quality", 25, _score_profitability(financials, info, industry_medians)),
        ("margins",       "Margin Power",         25, _score_margins(financials, info, industry_medians)),
        ("capital",       "Capital Efficiency",   15, _score_capital_efficiency(financials, cashflow, info)),
        ("reinvestment",  "Reinvestment Moat",    15, _score_reinvestment(financials, info)),
        ("intangibles",   "Intangible Assets",    10, _score_intangibles(balance_sheet, info)),
        ("fortress",      "Financial Fortress",   10, _score_fortress(balance_sheet, financials, info)),
    ]

    components = []
    total_weight = 0
    weighted_sum = 0
    for key, label, weight, (score, detail) in components_spec:
        comp = {
            "key": key,
            "label": label,
            "weight": weight,
            "score": round(score) if score is not None else None,
            "detail": detail,
            "verdict": _verdict_for_score(score) if score is not None else "neutral",
        }
        components.append(comp)
        if score is not None:
            weighted_sum += score * weight
            total_weight += weight

    composite = round(weighted_sum / total_weight) if total_weight else None
    return {
        "score": composite,
        "grade": _grade_moat(composite) if composite is not None else "N/A",
        "verdict": _verdict_for_score(composite) if composite is not None else "neutral",
        "components": components,
        "trends": _build_moat_trends(financials),
    }


def _build_moat_trends(financials):
    """Return a small time-series for the UI: gross margin, op margin, ROE."""
    revenue = _get_row(financials, "revenue")
    gross = _get_row(financials, "gross_profit")
    op_income = _get_row(financials, "operating_income")
    net_income = _get_row(financials, "net_income")
    equity = _get_row(financials, "total_equity")

    if revenue is None or revenue.empty:
        return None

    years = [d.strftime("%Y") for d in revenue.index]

    def pct_series(num_row, den_row):
        if num_row is None or den_row is None:
            return [None] * len(years)
        out = []
        for date in revenue.index:
            n = num_row.get(date)
            d = den_row.get(date)
            if n is not None and d not in (None, 0) and pd.notna(n) and pd.notna(d):
                out.append(round(float(n) / float(d) * 100, 1))
            else:
                out.append(None)
        return out

    return {
        "years": years,
        "grossMargin": pct_series(gross, revenue),
        "operatingMargin": pct_series(op_income, revenue),
        "roe": pct_series(net_income, equity),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Management scoring
# ─────────────────────────────────────────────────────────────────────────────

def _score_skin_in_game(info):
    held = info.get("heldPercentInsiders")
    if held is None:
        return None, "No insider ownership data"
    pct = held * 100 if held <= 1 else held  # yfinance is inconsistent
    if pct >= 10:
        base = 100
    elif pct >= 5:
        base = 75
    elif pct >= 1:
        base = 50
    else:
        base = 20
    return base, f"Insiders hold {pct:.2f}%"


def _summarize_insider_txns(insider_df, market_cap):
    """Return (score, detail, recent_list, aggregate) over the trailing 180 days."""
    if insider_df is None or insider_df.empty:
        return None, "No insider transaction data", [], None

    df = insider_df.copy()
    date_col = None
    for c in ("Start Date", "startDate", "Date", "date"):
        if c in df.columns:
            date_col = c
            break
    if date_col is None:
        return None, "Insider data missing date column", [], None

    df[date_col] = pd.to_datetime(df[date_col], errors="coerce", utc=True)
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=180)
    recent = df[df[date_col] >= cutoff].copy()
    if recent.empty:
        return 50, "No transactions in last 180 days", [], {
            "windowDays": 180, "netShares": 0, "netDollar": 0, "buys": 0, "sells": 0
        }

    text_col = "Text" if "Text" in recent.columns else (
        "Transaction" if "Transaction" in recent.columns else None
    )
    shares_col = "Shares" if "Shares" in recent.columns else (
        "shares" if "shares" in recent.columns else None
    )
    value_col = "Value" if "Value" in recent.columns else (
        "value" if "value" in recent.columns else None
    )
    name_col = "Insider" if "Insider" in recent.columns else (
        "name" if "name" in recent.columns else None
    )
    title_col = "Position" if "Position" in recent.columns else (
        "title" if "title" in recent.columns else None
    )

    def classify(txn_text):
        if not isinstance(txn_text, str):
            return 0
        t = txn_text.lower()
        if "sale" in t or "sold" in t or "sell" in t:
            return -1
        if "purchase" in t or "buy" in t or "bought" in t or "acquisition" in t:
            return 1
        return 0

    buys = sells = 0
    net_shares = 0.0
    net_dollar = 0.0
    recent_list = []
    for _, row in recent.iterrows():
        direction = classify(row.get(text_col)) if text_col else 0
        sh = float(row[shares_col]) if shares_col and pd.notna(row.get(shares_col)) else 0
        val = float(row[value_col]) if value_col and pd.notna(row.get(value_col)) else 0
        if direction > 0:
            buys += 1
            net_shares += sh
            net_dollar += val
        elif direction < 0:
            sells += 1
            net_shares -= sh
            net_dollar -= val
        recent_list.append({
            "date": row[date_col].strftime("%Y-%m-%d") if pd.notna(row[date_col]) else None,
            "name": row[name_col] if name_col else None,
            "title": row[title_col] if title_col else None,
            "type": "Buy" if direction > 0 else ("Sale" if direction < 0 else "Other"),
            "shares": int(sh) if sh else 0,
            "value": int(val) if val else 0,
        })

    recent_list = sorted(recent_list, key=lambda x: x["date"] or "", reverse=True)[:10]

    if market_cap and market_cap > 0:
        ratio = net_dollar / market_cap
        if ratio > 0.001:
            score = 100
        elif net_dollar > 0:
            score = 75
        elif ratio > -0.001:
            score = 50
        elif ratio > -0.005:
            score = 30
        else:
            score = 10
    else:
        score = 75 if net_dollar > 0 else (40 if net_dollar < 0 else 50)

    aggregate = {
        "windowDays": 180,
        "netShares": int(net_shares),
        "netDollar": int(net_dollar),
        "buys": buys,
        "sells": sells,
    }
    sign = "+" if net_dollar >= 0 else "−"
    detail = f"180d net {sign}${abs(net_dollar) / 1e6:.1f}M ({buys} buys / {sells} sales)"
    return score, detail, recent_list, aggregate


def _score_capital_allocation(financials, balance_sheet, cashflow, info):
    """Buybacks (shares ↓), dividend consistency, debt trajectory."""
    shares = _series_values(_get_row(balance_sheet, "shares"))
    score_parts = []
    detail_parts = []

    share_trend_pct = None
    if len(shares) >= 2 and shares[0] > 0:
        share_trend_pct = (shares[-1] - shares[0]) / shares[0] * 100
        if share_trend_pct < -10:
            score_parts.append(100)
            detail_parts.append(f"Buybacks {share_trend_pct:.1f}%")
        elif share_trend_pct < 0:
            score_parts.append(80)
            detail_parts.append(f"Buybacks {share_trend_pct:.1f}%")
        elif share_trend_pct < 2:
            score_parts.append(60)
            detail_parts.append("Flat share count")
        elif share_trend_pct < 10:
            score_parts.append(35)
            detail_parts.append(f"Dilution +{share_trend_pct:.1f}%")
        else:
            score_parts.append(10)
            detail_parts.append(f"Heavy dilution +{share_trend_pct:.1f}%")

    divs = _series_values(_get_row(cashflow, "dividends_paid"))
    if divs and all(v != 0 for v in divs):
        if len(divs) >= 3 and all(abs(divs[i]) >= abs(divs[i - 1]) * 0.95 for i in range(1, len(divs))):
            score_parts.append(85)
            detail_parts.append("Dividends rising")
        else:
            score_parts.append(65)
            detail_parts.append("Pays dividend")
    elif info.get("dividendYield"):
        score_parts.append(65)

    debt = _series_values(_get_row(balance_sheet, "total_debt"))
    if len(debt) >= 2 and debt[0] > 0:
        debt_change = (debt[-1] - debt[0]) / debt[0] * 100
        if debt_change < -10:
            score_parts.append(90)
            detail_parts.append(f"Debt ↓{abs(debt_change):.0f}%")
        elif debt_change < 10:
            score_parts.append(70)
            detail_parts.append("Debt stable")
        elif debt_change < 30:
            score_parts.append(45)
            detail_parts.append(f"Debt +{debt_change:.0f}%")
        else:
            score_parts.append(15)
            detail_parts.append(f"Debt ballooning +{debt_change:.0f}%")

    if not score_parts:
        return None, "Insufficient capital allocation data", {}

    avg = sum(score_parts) / len(score_parts)
    return _clamp(avg), " · ".join(detail_parts), {
        "shareCountTrend5y": round(share_trend_pct, 1) if share_trend_pct is not None else None,
        "dividendYield": info.get("dividendYield"),
    }


def _score_buffett_dollar_test(financials, info):
    """For every $1 retained over 5y, how many $ of market cap was added?"""
    retained = _series_values(_get_row(financials, "retained_earnings"))
    market_cap = info.get("marketCap")
    if len(retained) < 2 or not market_cap:
        return None, "Insufficient retained earnings data", None

    delta_retained = retained[-1] - retained[0]
    if delta_retained <= 0:
        return 40, "Retained earnings flat or declining", {
            "deltaRetained": int(delta_retained),
            "marketCap": int(market_cap),
            "ratio": None,
        }

    ratio = market_cap / delta_retained if delta_retained > 0 else None
    if ratio is None:
        return 50, "No clear test result", None

    if ratio >= 3:
        base = 100
    elif ratio >= 1.5:
        base = 80
    elif ratio >= 1:
        base = 70
    elif ratio >= 0.5:
        base = 40
    else:
        base = 15

    return base, f"$1 retained → ${ratio:.2f} of market cap", {
        "deltaRetained": int(delta_retained),
        "marketCap": int(market_cap),
        "ratio": round(ratio, 2),
    }


def _score_governance(info):
    risks = {
        "auditRisk": info.get("auditRisk"),
        "boardRisk": info.get("boardRisk"),
        "compensationRisk": info.get("compensationRisk"),
        "shareHolderRightsRisk": info.get("shareHolderRightsRisk"),
        "overallRisk": info.get("overallRisk"),
    }
    present = [v for v in risks.values() if isinstance(v, (int, float))]
    if not present:
        return None, "No governance data", risks

    avg = sum(present) / len(present)
    base = _clamp(100 - (avg - 1) * (100 / 9))
    qual = "Low risk" if avg <= 3 else ("Moderate" if avg <= 6 else "High risk")
    return base, f"{qual} (avg {avg:.1f}/10)", risks


def _compute_management(info, insider_df, financials, balance_sheet, cashflow):
    skin_score, skin_detail = _score_skin_in_game(info)
    insider_score, insider_detail, insider_recent, insider_agg = _summarize_insider_txns(
        insider_df, info.get("marketCap")
    )
    capalloc_res = _score_capital_allocation(financials, balance_sheet, cashflow, info)
    capalloc_score, capalloc_detail, capalloc_extra = capalloc_res if capalloc_res[0] is not None else (None, capalloc_res[1], {})
    dollar_score, dollar_detail, dollar_extra = _score_buffett_dollar_test(financials, info)
    gov_score, gov_detail, gov_risks = _score_governance(info)

    components_spec = [
        ("skin",        "Skin in the Game",       25, skin_score, skin_detail),
        ("insider",     "Insider Activity 180d",  15, insider_score, insider_detail),
        ("capalloc",    "Capital Allocation",     30, capalloc_score, capalloc_detail),
        ("dollar",      "Buffett's $1 Test",      20, dollar_score, dollar_detail),
        ("governance",  "Governance",             10, gov_score, gov_detail),
    ]

    components = []
    total_weight = 0
    weighted_sum = 0
    for key, label, weight, score, detail in components_spec:
        components.append({
            "key": key,
            "label": label,
            "weight": weight,
            "score": round(score) if score is not None else None,
            "detail": detail,
            "verdict": _verdict_for_score(score) if score is not None else "neutral",
        })
        if score is not None:
            weighted_sum += score * weight
            total_weight += weight

    composite = round(weighted_sum / total_weight) if total_weight else None
    return {
        "score": composite,
        "grade": _grade_management(composite) if composite is not None else "N/A",
        "verdict": _verdict_for_score(composite) if composite is not None else "neutral",
        "insiderOwnership": info.get("heldPercentInsiders"),
        "insiderActivity": {
            "aggregate": insider_agg,
            "recent": insider_recent,
        },
        "capitalAllocation": capalloc_extra or {},
        "buffettTest": dollar_extra or {},
        "governance": gov_risks,
        "components": components,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Value checks — Owner Earnings, Graham Number, MoS table
# ─────────────────────────────────────────────────────────────────────────────

def _compute_owner_earnings(financials, cashflow, info):
    """Buffett's Owner Earnings = Net Income + D&A − maintenance CapEx.

    yfinance reports CapEx as a negative cash outflow in newer versions and
    sometimes positive in older ones, so normalize to an absolute outflow.
    Intrinsic value is computed only when owner earnings are positive — a
    negative figure cannot be meaningfully capitalized.
    """
    ni = _series_values(_get_row(financials, "net_income"))
    da = _series_values(_get_row(cashflow, "depreciation"))
    capex = _series_values(_get_row(cashflow, "capex"))

    if not ni or not da or not capex:
        return None

    capex_outflow = abs(capex[-1])
    owner = ni[-1] + da[-1] - capex_outflow

    shares = info.get("sharesOutstanding")
    if not shares:
        return None

    per_share = owner / shares
    fair_multiple = 15  # Buffett's rough rule: a stable business earns 15× owner earnings
    intrinsic = round(per_share * fair_multiple, 2) if owner > 0 else None

    return {
        "perShare": round(per_share, 2),
        "total": int(owner),
        "method": "NI + D&A − |CapEx|",
        "intrinsic": intrinsic,
        "multiple": fair_multiple,
    }


def _compute_graham_number(info):
    """Graham Number = √(22.5 × EPS × BookValuePerShare). Negative inputs → None."""
    eps = info.get("trailingEps")
    bvps = info.get("bookValue")
    if eps is None or bvps is None or eps <= 0 or bvps <= 0:
        return None
    return round(math.sqrt(22.5 * eps * bvps), 2)


def _build_mos_table(dcf_result, owner_data, graham, current_price):
    methods = []

    if dcf_result and "intrinsicValue" in dcf_result and current_price:
        intrinsic = dcf_result["intrinsicValue"]
        mos = (intrinsic - current_price) / intrinsic * 100 if intrinsic else None
        methods.append({
            "key": "dcf", "label": "DCF",
            "intrinsic": intrinsic, "price": current_price,
            "mosPercent": round(mos, 1) if mos is not None else None,
            "verdict": _verdict_for_mos(mos),
        })

    if owner_data and owner_data.get("intrinsic") and current_price:
        intrinsic = owner_data["intrinsic"]
        mos = (intrinsic - current_price) / intrinsic * 100 if intrinsic else None
        methods.append({
            "key": "owner", "label": "Owner Earnings",
            "intrinsic": intrinsic, "price": current_price,
            "mosPercent": round(mos, 1) if mos is not None else None,
            "verdict": _verdict_for_mos(mos),
        })

    if graham and current_price:
        mos = (graham - current_price) / graham * 100 if graham else None
        methods.append({
            "key": "graham", "label": "Graham Number",
            "intrinsic": graham, "price": current_price,
            "mosPercent": round(mos, 1) if mos is not None else None,
            "verdict": _verdict_for_mos(mos),
        })

    return methods


def _verdict_for_mos(mos_pct):
    if mos_pct is None:
        return "neutral"
    if mos_pct >= 25:
        return "good"
    if mos_pct >= 0:
        return "neutral"
    return "bad"


def _summarize_mos(methods):
    if not methods:
        return "No valuation methods available"
    safe = sum(1 for m in methods if m["verdict"] == "good")
    fair = sum(1 for m in methods if m["verdict"] == "neutral")
    total = len(methods)
    if safe == total:
        return f"All {total} methods show margin of safety — strong conviction"
    if safe >= 2:
        return f"{safe} of {total} methods show margin of safety — good entry candidate"
    if safe + fair == total:
        return f"Fair value across {total} methods — wait for pullback"
    return f"{total - safe - fair} of {total} methods show stock is above intrinsic value"


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────────────────

def _build_overview(info, symbol):
    officers_raw = info.get("companyOfficers") or []
    officers = []
    for o in officers_raw[:6]:
        officers.append({
            "name": o.get("name"),
            "title": o.get("title"),
            "age": o.get("age"),
            "totalPay": o.get("totalPay"),
        })

    return {
        "name": info.get("longName") or info.get("shortName") or symbol,
        "ticker": symbol,
        "sector": info.get("sectorDisp") or info.get("sector", "N/A"),
        "industry": info.get("industryDisp") or info.get("industry", "N/A"),
        "country": info.get("country"),
        "website": info.get("website"),
        "employees": info.get("fullTimeEmployees"),
        "marketCap": info.get("marketCap"),
        "currency": info.get("currency", ""),
        "businessSummary": info.get("longBusinessSummary"),
        "officers": officers,
    }


def fetch_research(ticker: str, market: str = "set") -> dict:
    symbol = ticker.strip().upper()
    if market == "set" and not symbol.endswith(".BK"):
        symbol += ".BK"

    info = get_cached_info(symbol)
    if not info:
        invalidate_cache(symbol)
        return {"error": f"No data found for {symbol}", "retryable": True}

    has_price = info.get("currentPrice") or info.get("regularMarketPrice")
    has_identity = info.get("quoteType") or info.get("longName") or info.get("shortName")
    if not has_price and not has_identity:
        invalidate_cache(symbol)
        return {"error": f"No data found for {symbol}", "retryable": True}

    financials_bundle = get_cached_financials(symbol) or {}
    financials = financials_bundle.get("financials")
    balance_sheet = financials_bundle.get("balance_sheet")
    cashflow = financials_bundle.get("cashflow")

    industry_data = fetch_industry_medians(info.get("industryKey", ""), exclude_symbol=symbol)
    industry_medians = industry_data.get("medians", {}) if industry_data else {}

    insider_df = get_cached_insider_txns(symbol)

    moat = _compute_moat(financials, balance_sheet, cashflow, info, industry_medians)
    management = _compute_management(info, insider_df, financials, balance_sheet, cashflow)

    try:
        dcf = fetch_dcf(ticker, market)
        if "error" in dcf:
            dcf = None
    except Exception as e:
        logger.warning(f"fetch_research: DCF failed for {symbol}: {e}")
        dcf = None

    current_price = info.get("currentPrice") or info.get("regularMarketPrice")
    owner = _compute_owner_earnings(financials, cashflow, info)
    graham = _compute_graham_number(info)
    mos_methods = _build_mos_table(dcf, owner, graham, current_price)

    missing = []
    if financials is None or financials.empty:
        missing.append("financials")
    if insider_df is None:
        missing.append("insider_transactions")
    if not industry_medians:
        missing.append("industry_medians")
    thin_for_set = market == "set" and len(missing) >= 2

    return {
        "overview": _build_overview(info, symbol),
        "moat": moat,
        "management": management,
        "valueChecks": {
            "ownerEarnings": owner,
            "grahamNumber": graham,
            "marginOfSafety": mos_methods,
            "summary": _summarize_mos(mos_methods),
            "currency": info.get("currency", ""),
        },
        "dataQuality": {
            "missing": missing,
            "thinForSetMarket": thin_for_set,
        },
    }
