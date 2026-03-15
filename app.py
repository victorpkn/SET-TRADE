import os
from flask import Flask, render_template, jsonify, request, session, redirect, url_for
from services.stock_data import fetch_stock_data, normalize_ticker
from services.technical import compute_indicators
from services.signals import evaluate_signals
from services.fundamentals import fetch_fundamentals
from services.valuation import fetch_dcf
from services.backtest import run_backtest
from services.set_tickers import search_set
from concurrent.futures import ThreadPoolExecutor

import yfinance as yf

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-key-change-me")

SITE_PASSWORD = os.environ.get("SITE_PASSWORD", "")


@app.before_request
def require_password():
    if not SITE_PASSWORD:
        return
    open_paths = ("/login","/static/")
    if any(request.path.startswith(p) for p in open_paths):
        return
    if not session.get("authenticated"):
        return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        pw = request.form.get("password", "")
        if pw == SITE_PASSWORD:
            session["authenticated"] = True
            return redirect(url_for("index"))
        error = "Incorrect password"
    return render_template("login.html", error=error)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/stock/<ticker>")
def get_stock(ticker):
    period = request.args.get("period", "6mo")
    market = request.args.get("market", "set")

    params = {
        "sma_short": int(request.args.get("sma_short", 20)),
        "sma_long": int(request.args.get("sma_long", 50)),
        "macd_fast": int(request.args.get("macd_fast", 12)),
        "macd_slow": int(request.args.get("macd_slow", 26)),
        "macd_signal": int(request.args.get("macd_signal", 9)),
        "stoch_k": int(request.args.get("stoch_k", 14)),
        "stoch_smooth": int(request.args.get("stoch_smooth", 3)),
        "stoch_ob": int(request.args.get("stoch_ob", 80)),
        "stoch_os": int(request.args.get("stoch_os", 20)),
    }

    data = fetch_stock_data(ticker, period, market)
    if "error" in data:
        return jsonify(data), 404

    df = data.pop("df")
    indicators = compute_indicators(df, params)

    raw = indicators.pop("raw")
    signal = evaluate_signals(raw, df["Close"], params)

    data["indicators"] = indicators
    data["signal"] = signal

    return jsonify(data)


@app.route("/api/summary/<ticker>")
def get_summary(ticker):
    market = request.args.get("market", "set")
    data = fetch_fundamentals(ticker, market)
    if "error" in data:
        return jsonify(data), 404
    return jsonify(data)


@app.route("/api/valuation/<ticker>")
def get_valuation(ticker):
    market = request.args.get("market", "set")
    overrides = {}
    for key in ("growth_rate", "discount_rate", "terminal_growth", "projection_years"):
        val = request.args.get(key)
        if val is not None:
            try:
                overrides[key] = float(val)
            except ValueError:
                pass
    data = fetch_dcf(ticker, market, overrides if overrides else None)
    if "error" in data:
        return jsonify(data), 404
    return jsonify(data)


@app.route("/api/sparkline/<ticker>")
def get_sparkline(ticker):
    market = request.args.get("market", "set")
    symbol = normalize_ticker(ticker, market)
    stock = yf.Ticker(symbol)
    df = stock.history(period="1mo", interval="1d")
    if df.empty:
        return jsonify({"error": "No data"}), 404
    closes = df["Close"].dropna().tolist()
    closes = [round(c, 2) for c in closes]
    last = closes[-1] if closes else 0
    first = closes[0] if closes else 0
    change_pct = round(((last - first) / first) * 100, 2) if first else 0
    return jsonify({
        "ticker": symbol,
        "closes": closes,
        "price": last,
        "changePct": change_pct,
    })


@app.route("/api/search")
def search_tickers():
    q = request.args.get("q", "").strip()
    market = request.args.get("market", "set")
    if len(q) < 1:
        return jsonify([])

    if market == "set":
        return jsonify(search_set(q, max_results=8))

    try:
        results = yf.Search(q, max_results=8)
        quotes = results.quotes if hasattr(results, "quotes") else []
        out = []
        for item in quotes:
            symbol = item.get("symbol", "")
            name = item.get("shortname") or item.get("longname") or ""
            exchange = item.get("exchDisp") or item.get("exchange", "")
            qtype = item.get("quoteType", "")
            if qtype not in ("EQUITY", "ETF"):
                continue
            out.append({"symbol": symbol, "name": name, "exchange": exchange})
        return jsonify(out[:8])
    except Exception:
        return jsonify([])


@app.route("/api/portfolio", methods=["POST"])
def get_portfolio():
    body = request.get_json(silent=True)
    if not body or not isinstance(body, list) or len(body) == 0:
        return jsonify({"error": "Send a JSON array of positions"}), 400

    def enrich(pos):
        ticker = pos.get("ticker", "")
        market = pos.get("market", "set")
        shares = float(pos.get("shares", 0))
        avg_cost = float(pos.get("avgCost", 0))
        symbol = normalize_ticker(ticker, market)
        try:
            stock = yf.Ticker(symbol)
            info = stock.info
            price = info.get("currentPrice") or info.get("regularMarketPrice") or 0
            prev_close = info.get("previousClose") or price
            day_change = ((price - prev_close) / prev_close * 100) if prev_close else 0
            name = info.get("longName") or info.get("shortName") or symbol
            sector = info.get("sector") or "Unknown"
            industry = info.get("industry") or "Unknown"
            currency = info.get("currency") or ("THB" if market == "set" else "USD")
            market_cap = info.get("marketCap") or 0
            pe = info.get("trailingPE")
            raw_div = info.get("dividendYield")
            div_yield = raw_div if raw_div and raw_div > 1 else (raw_div * 100 if raw_div else None)
            beta = info.get("beta")
        except Exception:
            return None

        value = shares * price
        cost = shares * avg_cost
        pnl = value - cost
        pnl_pct = (pnl / cost * 100) if cost > 0 else 0
        day_pnl = shares * price * (day_change / 100) if price else 0

        return {
            "ticker": ticker.upper(),
            "symbol": symbol,
            "name": name,
            "market": market,
            "sector": sector,
            "industry": industry,
            "currency": currency,
            "shares": shares,
            "avgCost": avg_cost,
            "price": round(price, 2),
            "dayChange": round(day_change, 2),
            "dayPnl": round(day_pnl, 2),
            "marketCap": market_cap,
            "pe": round(pe, 2) if pe else None,
            "divYield": round(div_yield, 2) if div_yield else None,
            "beta": round(beta, 2) if beta else None,
            "value": round(value, 2),
            "cost": round(cost, 2),
            "pnl": round(pnl, 2),
            "pnlPct": round(pnl_pct, 2),
        }

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(enrich, body))

    holdings = [r for r in results if r is not None]

    total_value = sum(h["value"] for h in holdings)
    total_cost = sum(h["cost"] for h in holdings)
    total_pnl = total_value - total_cost
    total_pnl_pct = (total_pnl / total_cost * 100) if total_cost > 0 else 0
    total_day_pnl = sum(h["dayPnl"] for h in holdings)

    for h in holdings:
        h["weight"] = round((h["value"] / total_value * 100) if total_value > 0 else 0, 1)

    sector_map = {}
    for h in holdings:
        s = h["sector"]
        sector_map[s] = sector_map.get(s, 0) + h["value"]
    sectors = [{"name": k, "value": round(v, 2), "pct": round(v / total_value * 100, 1) if total_value > 0 else 0} for k, v in sorted(sector_map.items(), key=lambda x: -x[1])]

    return jsonify({
        "totalValue": round(total_value, 2),
        "totalCost": round(total_cost, 2),
        "totalPnl": round(total_pnl, 2),
        "totalPnlPct": round(total_pnl_pct, 2),
        "totalDayPnl": round(total_day_pnl, 2),
        "holdings": holdings,
        "sectors": sectors,
    })


@app.route("/api/backtest/<ticker>")
def get_backtest(ticker):
    market = request.args.get("market", "set")
    period = request.args.get("period", "2y")

    params = {
        "sma_short": int(request.args.get("sma_short", 20)),
        "sma_long": int(request.args.get("sma_long", 50)),
        "macd_fast": int(request.args.get("macd_fast", 12)),
        "macd_slow": int(request.args.get("macd_slow", 26)),
        "macd_signal": int(request.args.get("macd_signal", 9)),
        "stoch_k": int(request.args.get("stoch_k", 14)),
        "stoch_smooth": int(request.args.get("stoch_smooth", 3)),
        "stoch_ob": int(request.args.get("stoch_ob", 80)),
        "stoch_os": int(request.args.get("stoch_os", 20)),
    }

    active = request.args.get("active", "sma,macd,stochastic")
    active_list = [a.strip() for a in active.split(",") if a.strip()]

    result = run_backtest(ticker, market, period, params, active_list)
    if "error" in result:
        return jsonify(result), 404
    return jsonify(result)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
