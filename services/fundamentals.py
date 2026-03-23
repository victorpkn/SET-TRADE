from services.yf_session import get_cached_info
from services.industry import fetch_industry_medians


RATIO_RULES = {
    "trailingPE": {
        "label": "P/E (TTM)",
        "category": "valuation",
        "format": "number",
        "thresholds": [(15, "good", "Undervalued"), (25, "neutral", "Fair"), (None, "bad", "Expensive")],
        "tooltip": "Price-to-Earnings ratio compares stock price to earnings per share. It tells you how much investors are paying for each dollar of profit. Lower P/E may signal a bargain; higher P/E suggests the market expects strong future growth.",
        "goodRange": "Below 15",
    },
    "forwardPE": {
        "label": "P/E (Forward)",
        "category": "valuation",
        "format": "number",
        "thresholds": [(15, "good", "Undervalued"), (25, "neutral", "Fair"), (None, "bad", "Expensive")],
        "tooltip": "Forward P/E uses analyst earnings estimates for the next 12 months instead of trailing earnings. It's useful for companies with expected earnings changes. A lower forward P/E than trailing P/E suggests analysts expect earnings to grow.",
        "goodRange": "Below 15",
    },
    "priceToBook": {
        "label": "P/B",
        "category": "valuation",
        "format": "number",
        "thresholds": [(1, "good", "Undervalued"), (3, "neutral", "Fair"), (None, "bad", "High")],
        "tooltip": "Price-to-Book ratio compares stock price to net asset value per share. A P/B below 1 means the stock trades below the company's book value — potentially a deep value opportunity. Asset-heavy industries (banks, utilities) typically have lower P/B.",
        "goodRange": "Below 1.0",
    },
    "priceToSalesTrailing12Months": {
        "label": "P/S",
        "category": "valuation",
        "format": "number",
        "thresholds": [(2, "good", "Cheap"), (5, "neutral", "Fair"), (None, "bad", "Expensive")],
        "tooltip": "Price-to-Sales ratio compares stock price to revenue per share. Useful for unprofitable or early-stage companies where earnings-based ratios don't work. Lower is better — it means you're paying less for each dollar of revenue.",
        "goodRange": "Below 2.0",
    },
    "enterpriseToEbitda": {
        "label": "EV/EBITDA",
        "category": "valuation",
        "format": "number",
        "thresholds": [(10, "good", "Undervalued"), (20, "neutral", "Fair"), (None, "bad", "Expensive")],
        "tooltip": "Enterprise Value to EBITDA measures total company value (including debt) relative to operating profit. It's capital-structure neutral, making it ideal for comparing companies with different debt levels. Lower means cheaper relative to cash flow.",
        "goodRange": "Below 10",
    },
    "profitMargins": {
        "label": "Profit Margin",
        "category": "profitability",
        "format": "percent",
        "thresholds": [(0.20, "good", "Excellent"), (0.10, "neutral", "Decent"), (None, "bad", "Low")],
        "reverse": True,
        "tooltip": "Net profit margin shows what percentage of revenue becomes actual profit after all expenses. High margins indicate pricing power and cost efficiency. It varies by industry — tech often exceeds 20%, while retail may be 2–5%.",
        "goodRange": "Above 20%",
    },
    "operatingMargins": {
        "label": "Operating Margin",
        "category": "profitability",
        "format": "percent",
        "thresholds": [(0.20, "good", "Excellent"), (0.10, "neutral", "Decent"), (None, "bad", "Low")],
        "reverse": True,
        "tooltip": "Operating margin measures profit from core business operations before interest and taxes. It strips out financing decisions and tax effects, giving a cleaner view of operational efficiency. Rising operating margins signal improving business execution.",
        "goodRange": "Above 20%",
    },
    "returnOnEquity": {
        "label": "ROE",
        "category": "profitability",
        "format": "percent",
        "thresholds": [(0.15, "good", "Strong"), (0.10, "neutral", "Okay"), (None, "bad", "Weak")],
        "reverse": True,
        "tooltip": "Return on Equity measures how much profit the company generates with shareholders' invested capital. A high ROE means the company is efficiently turning equity into profit. Warren Buffett famously looks for ROE consistently above 15%.",
        "goodRange": "Above 15%",
    },
    "returnOnAssets": {
        "label": "ROA",
        "category": "profitability",
        "format": "percent",
        "thresholds": [(0.10, "good", "Strong"), (0.05, "neutral", "Okay"), (None, "bad", "Weak")],
        "reverse": True,
        "tooltip": "Return on Assets measures how efficiently the company uses all of its assets to generate profit. Unlike ROE, it accounts for debt — so it's harder to inflate with leverage. Higher ROA means more profit from fewer assets.",
        "goodRange": "Above 10%",
    },
    "currentRatio": {
        "label": "Current Ratio",
        "category": "health",
        "format": "number",
        "thresholds": [(1.5, "good", "Healthy"), (1.0, "neutral", "Tight"), (None, "bad", "Risky")],
        "reverse": True,
        "tooltip": "Current ratio measures whether the company can pay short-term debts with short-term assets. A ratio above 1 means assets exceed liabilities. Below 1 may signal liquidity risk — the company could struggle to pay bills coming due.",
        "goodRange": "Above 1.5",
    },
    "debtToEquity": {
        "label": "Debt/Equity",
        "category": "health",
        "format": "number",
        "thresholds": [(50, "good", "Low leverage"), (100, "neutral", "Moderate"), (None, "bad", "High leverage")],
        "tooltip": "Debt-to-Equity ratio shows how much debt the company uses relative to shareholder equity. High leverage amplifies both gains and losses. A D/E above 100% means more debt than equity — risky during downturns but can boost returns in good times.",
        "goodRange": "Below 50%",
    },
    "quickRatio": {
        "label": "Quick Ratio",
        "category": "health",
        "format": "number",
        "thresholds": [(1.0, "good", "Healthy"), (0.7, "neutral", "Tight"), (None, "bad", "Risky")],
        "reverse": True,
        "tooltip": "Quick ratio is a stricter version of current ratio — it excludes inventory (which may be hard to sell quickly). It answers: can the company pay its short-term debts with just cash and receivables? Above 1.0 is a comfortable position.",
        "goodRange": "Above 1.0",
    },
    "dividendYield": {
        "label": "Dividend Yield",
        "category": "dividend",
        "format": "percent",
        "thresholds": [(0.03, "good", "Attractive"), (0.01, "neutral", "Modest"), (None, "bad", "Low")],
        "reverse": True,
        "tooltip": "Dividend yield is the annual dividend payment as a percentage of stock price. Higher yield means more income per dollar invested. But very high yields (>8%) can signal the market expects a dividend cut — always check the payout ratio too.",
        "goodRange": "Above 3%",
    },
    "payoutRatio": {
        "label": "Payout Ratio",
        "category": "dividend",
        "format": "percent",
        "thresholds": [(0.60, "good", "Sustainable"), (0.80, "neutral", "High"), (None, "bad", "Unsustainable")],
        "tooltip": "Payout ratio shows what portion of earnings is paid out as dividends. A low ratio means the company retains more profit for growth. Above 80% is risky — leaves little buffer for earnings dips. Above 100% means dividends exceed earnings (unsustainable).",
        "goodRange": "Below 60%",
    },
    "revenueGrowth": {
        "label": "Revenue Growth",
        "category": "growth",
        "format": "percent",
        "thresholds": [(0.10, "good", "Strong"), (0.03, "neutral", "Moderate"), (None, "bad", "Weak")],
        "reverse": True,
        "tooltip": "Year-over-year revenue growth shows how fast the company's top line is expanding. Consistent revenue growth is a sign of market demand and competitive strength. High-growth companies typically see >10% annually, while mature companies grow 3–5%.",
        "goodRange": "Above 10%",
    },
    "earningsGrowth": {
        "label": "Earnings Growth",
        "category": "growth",
        "format": "percent",
        "thresholds": [(0.15, "good", "Strong"), (0.05, "neutral", "Moderate"), (None, "bad", "Weak")],
        "reverse": True,
        "tooltip": "Year-over-year earnings growth measures how fast profits are increasing. Earnings growth above revenue growth signals improving efficiency. Consistent earnings growth is one of the strongest predictors of long-term stock performance.",
        "goodRange": "Above 15%",
    },
}

CATEGORY_ORDER = ["valuation", "profitability", "health", "dividend", "growth"]


def _evaluate_ratio(value, rule, industry_median=None):
    is_reverse = rule.get("reverse", False)

    if industry_median is not None and industry_median != 0:
        pct_diff = (value - industry_median) / abs(industry_median) * 100

        if is_reverse:
            # Higher is better (margins, ROE, growth, etc.)
            if pct_diff > 10:
                return "good", "Above industry"
            elif pct_diff < -10:
                return "bad", "Below industry"
            else:
                return "neutral", "Near industry avg"
        else:
            # Lower is better (P/E, debt, etc.)
            if pct_diff < -10:
                return "good", "Below industry"
            elif pct_diff > 10:
                return "bad", "Above industry"
            else:
                return "neutral", "Near industry avg"

    thresholds = rule["thresholds"]
    if is_reverse:
        for thresh_val, verdict, desc in thresholds:
            if thresh_val is None:
                return verdict, desc
            if value >= thresh_val:
                return verdict, desc
        return thresholds[-1][1], thresholds[-1][2]
    else:
        for thresh_val, verdict, desc in thresholds:
            if thresh_val is None:
                return verdict, desc
            if value <= thresh_val:
                return verdict, desc
        return thresholds[-1][1], thresholds[-1][2]


def _format_value(value, fmt):
    if value is None:
        return "N/A"
    if fmt == "percent":
        return f"{value * 100:.1f}%"
    return f"{value:.2f}"


def _format_market_cap(value):
    if value is None:
        return "N/A"
    if value >= 1e12:
        return f"${value / 1e12:.2f}T"
    if value >= 1e9:
        return f"${value / 1e9:.2f}B"
    if value >= 1e6:
        return f"${value / 1e6:.1f}M"
    return f"${value:,.0f}"


def fetch_fundamentals(ticker: str, market: str = "set") -> dict:
    symbol = ticker.strip().upper()
    if market == "set" and not symbol.endswith(".BK"):
        symbol += ".BK"

    try:
        info = get_cached_info(symbol)
    except Exception:
        info = None

    if not info or info.get("quoteType") is None:
        return {"error": f"No data found for {symbol}"}

    overview = {
        "name": info.get("longName") or info.get("shortName") or symbol,
        "ticker": symbol,
        "sector": info.get("sectorDisp") or info.get("sector", "N/A"),
        "industry": info.get("industryDisp") or info.get("industry", "N/A"),
        "marketCap": _format_market_cap(info.get("marketCap")),
        "price": info.get("currentPrice") or info.get("regularMarketPrice"),
        "previousClose": info.get("regularMarketPreviousClose") or info.get("previousClose"),
        "dayChange": info.get("regularMarketChangePercent"),
        "currency": info.get("currency", ""),
        "fiftyTwoWeekHigh": info.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow": info.get("fiftyTwoWeekLow"),
        "employees": info.get("fullTimeEmployees"),
    }

    price = overview["price"]
    low52 = overview["fiftyTwoWeekLow"]
    high52 = overview["fiftyTwoWeekHigh"]
    if price and low52 and high52 and high52 > low52:
        overview["fiftyTwoWeekPercent"] = round(
            (price - low52) / (high52 - low52) * 100, 1
        )
    else:
        overview["fiftyTwoWeekPercent"] = None

    industry_key = info.get("industryKey", "")
    industry_data = fetch_industry_medians(industry_key, exclude_symbol=symbol)
    medians = industry_data.get("medians", {}) if industry_data else {}
    peer_count = industry_data.get("peerCount", 0) if industry_data else 0

    ratios = {}
    for key, rule in RATIO_RULES.items():
        value = info.get(key)
        cat = rule["category"]
        if cat not in ratios:
            ratios[cat] = []

        median_val = medians.get(key)
        base = {
            "label": rule["label"],
            "tooltip": rule.get("tooltip", ""),
            "goodRange": rule.get("goodRange", ""),
        }

        if median_val is not None:
            base["industryMedian"] = median_val
            base["industryMedianFmt"] = _format_value(median_val, rule["format"])

        if value is not None:
            verdict, desc = _evaluate_ratio(value, rule, industry_median=median_val)
            base.update({
                "value": _format_value(value, rule["format"]),
                "rawValue": round(value, 4),
                "verdict": verdict,
                "description": desc,
            })
            if median_val is not None and median_val != 0:
                base["vsIndustry"] = round(
                    (value - median_val) / abs(median_val) * 100, 1
                )
        else:
            base.update({
                "value": "N/A",
                "rawValue": None,
                "verdict": "neutral",
                "description": "Not available",
            })

        ratios[cat].append(base)

    ordered_ratios = []
    for cat in CATEGORY_ORDER:
        if cat in ratios:
            ordered_ratios.append({"category": cat, "items": ratios[cat]})

    analyst = None
    rec_key = info.get("recommendationKey")
    if rec_key:
        analyst = {
            "recommendation": rec_key,
            "score": info.get("recommendationMean"),
            "targetMean": info.get("targetMeanPrice"),
            "targetMedian": info.get("targetMedianPrice"),
            "targetHigh": info.get("targetHighPrice"),
            "targetLow": info.get("targetLowPrice"),
            "numberOfAnalysts": info.get("numberOfAnalystOpinions"),
        }

    industry_info = None
    if medians:
        industry_info = {
            "name": info.get("industryDisp") or info.get("industry", ""),
            "peerCount": peer_count,
        }

    return {
        "overview": overview,
        "ratios": ordered_ratios,
        "analyst": analyst,
        "industryInfo": industry_info,
    }
