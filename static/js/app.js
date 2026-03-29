(() => {
    "use strict";

    let currentLang = "en";
    let currentPeriod = "6mo";
    let currentMarket = "set";
    let currentTicker = "";
    let lastRawSignal = null;
    let activeIndicators = new Set(["sma", "macd", "stochastic"]);
    let summaryCache = {};
    let valuationCache = {};
    let translations = {};
    let watchlist = [];
    let compareMode = false;
    let positions = {};
    let searchSeq = 0;
    let searchAbort = null;

    let priceChart, macdChart, stochChart;
    let priceCandleSeries = null;
    let lastUpdatedTime = null;
    let lastIndicatorData = null;
    let syncingCrosshair = false;

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
        const controller = new AbortController();
        const existing = opts.signal;
        if (existing) existing.addEventListener("abort", () => controller.abort());
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(url, { ...opts, signal: controller.signal }).then(res => {
            clearTimeout(timer);
            return res;
        }, err => {
            clearTimeout(timer);
            if (err.name === "AbortError" && !existing?.aborted) {
                const timeout = new Error("Request timed out — server may be busy. Try again.");
                timeout.name = "TimeoutError";
                timeout.retryable = true;
                throw timeout;
            }
            throw err;
        });
    }

    // ── Settings ──

    const DEFAULT_SETTINGS = {
        sensitivity: "normal", smaShort: 20, smaLong: 50,
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        stochK: 14, stochSmooth: 3, stochOb: 80, stochOs: 20,
    };
    let settings = { ...DEFAULT_SETTINGS };

    function loadSettings() {
        try { const s = localStorage.getItem("setTradeSettings"); if (s) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) }; } catch {}
    }
    function saveSettings() { localStorage.setItem("setTradeSettings", JSON.stringify(settings)); }

    function settingsToQuery() {
        return `&sma_short=${settings.smaShort}&sma_long=${settings.smaLong}` +
            `&macd_fast=${settings.macdFast}&macd_slow=${settings.macdSlow}&macd_signal=${settings.macdSignal}` +
            `&stoch_k=${settings.stochK}&stoch_smooth=${settings.stochSmooth}` +
            `&stoch_ob=${settings.stochOb}&stoch_os=${settings.stochOs}`;
    }

    function populateSettingsUI() {
        $("#sma-short").value = settings.smaShort;
        $("#sma-long").value = settings.smaLong;
        $("#macd-fast").value = settings.macdFast;
        $("#macd-slow").value = settings.macdSlow;
        $("#macd-signal").value = settings.macdSignal;
        $("#stoch-k").value = settings.stochK;
        $("#stoch-smooth").value = settings.stochSmooth;
        $("#stoch-ob").value = settings.stochOb;
        $("#stoch-os").value = settings.stochOs;
        $$(".btn-sensitivity").forEach(b => b.classList.toggle("active", b.dataset.sensitivity === settings.sensitivity));
        updateSensitivityDesc();
        updateIndicatorSummaries();
    }

    function updateIndicatorSummaries() {
        const s = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
        s("#sma-summary", `${settings.smaShort} / ${settings.smaLong}`);
        s("#macd-summary", `${settings.macdFast} / ${settings.macdSlow} / ${settings.macdSignal}`);
        s("#stoch-summary", `${settings.stochK} / ${settings.stochSmooth} · ${settings.stochOb}/${settings.stochOs}`);
    }

    function readSettingsFromUI() {
        settings.smaShort = parseInt($("#sma-short").value);
        settings.smaLong = parseInt($("#sma-long").value);
        settings.macdFast = parseInt($("#macd-fast").value);
        settings.macdSlow = parseInt($("#macd-slow").value);
        settings.macdSignal = parseInt($("#macd-signal").value);
        settings.stochK = parseInt($("#stoch-k").value);
        settings.stochSmooth = parseInt($("#stoch-smooth").value);
        settings.stochOb = parseInt($("#stoch-ob").value);
        settings.stochOs = parseInt($("#stoch-os").value);
        const ab = $(".btn-sensitivity.active");
        if (ab) settings.sensitivity = ab.dataset.sensitivity;
        updateIndicatorSummaries();
    }

    const sensDescKeys = { conservative: "conservativeDesc", normal: "normalDesc", aggressive: "aggressiveDesc" };
    function updateSensitivityDesc() {
        const d = $("#sensitivity-desc"), k = sensDescKeys[settings.sensitivity] || "normalDesc";
        d.setAttribute("data-i18n", k); d.textContent = t(k);
    }

    // ── i18n ──

    async function loadTranslations() {
        const [en, th] = await Promise.all([
            fetch("/static/i18n/en.json").then(r => r.json()),
            fetch("/static/i18n/th.json").then(r => r.json()),
        ]);
        translations = { en, th };
    }

    function t(key) { return (translations[currentLang] && translations[currentLang][key]) || key; }

    function applyLanguage() {
        $$("[data-i18n]").forEach(el => {
            const key = el.getAttribute("data-i18n"), val = t(key);
            if (val !== key) el.textContent = val;
        });
        const input = $("#ticker-input");
        const phKey = currentMarket === "us" ? "placeholderUs" : "placeholder";
        const ph = t(phKey);
        if (ph !== phKey) input.placeholder = ph;
        if (lastRawSignal) renderSignal(lastRawSignal);
    }

    // ── Watchlist ──

    function loadWatchlist() {
        try { const w = localStorage.getItem("setTradeWatchlist"); if (w) watchlist = JSON.parse(w); } catch {}
    }
    function saveWatchlist() { localStorage.setItem("setTradeWatchlist", JSON.stringify(watchlist)); }

    function renderWatchlist() {
        const container = $("#watchlist-items");
        const empty = $("#watchlist-empty");
        if (!watchlist.length) { container.innerHTML = ""; empty.classList.remove("hidden"); return; }
        empty.classList.add("hidden");
        container.innerHTML = watchlist.map((item, idx) => {
            const chgClass = (item.changePct || 0) >= 0 ? "up" : "down";
            const chgSign = (item.changePct || 0) >= 0 ? "+" : "";
            const isActive = item.ticker === currentTicker && item.market === currentMarket;
            const pos = getPosition(item.displayTicker, item.market);
            let pnlHtml = "";
            if (pos && item.price) {
                const r = calcPnl(pos, item.price);
                if (r) {
                    const pSign = r.pnl >= 0 ? "+" : "";
                    const pCls = r.pnl >= 0 ? "profit" : "loss";
                    pnlHtml = `<div class="wl-pnl ${pCls}">${pos.shares}sh · ${pSign}${r.pnlPct.toFixed(1)}%</div>`;
                }
            }
            const posBadge = pos ? `<span class="wl-pos-badge">POS</span>` : "";
            return `<div class="wl-item ${isActive ? "active" : ""}" data-idx="${idx}">
                <div class="wl-info">
                    <div class="wl-ticker">${item.displayTicker}${posBadge}</div>
                    <div class="wl-price">${item.price ? item.price.toFixed(2) : "..."} <span class="wl-change ${chgClass}">${chgSign}${(item.changePct || 0).toFixed(1)}%</span></div>
                    ${pnlHtml}
                </div>
                <svg class="wl-sparkline" data-idx="${idx}" viewBox="0 0 56 24" preserveAspectRatio="none"></svg>
                <button class="wl-remove" data-idx="${idx}">&times;</button>
            </div>`;
        }).join("");

        container.querySelectorAll(".wl-item").forEach(el => {
            el.addEventListener("click", (e) => {
                if (e.target.closest(".wl-remove")) return;
                const item = watchlist[el.dataset.idx];
                if (!item) return;
                $("#ticker-input").value = item.displayTicker;
                if (item.market !== currentMarket) {
                    currentMarket = item.market;
                    $$(".btn-market-pill").forEach(b => b.classList.toggle("active", b.dataset.market === currentMarket));
                }
                doSearch();
            });
        });
        container.querySelectorAll(".wl-remove").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                watchlist.splice(parseInt(btn.dataset.idx), 1);
                saveWatchlist(); renderWatchlist();
            });
        });

        watchlist.forEach((item, idx) => {
            if (item.closes && item.closes.length > 1) drawSparkline(idx, item.closes, item.changePct >= 0);
        });
    }

    function drawSparkline(idx, closes, isUp) {
        const svg = $(`.wl-sparkline[data-idx="${idx}"]`);
        if (!svg) return;
        const w = 56, h = 24;
        const min = Math.min(...closes), max = Math.max(...closes);
        const range = max - min || 1;
        const pts = closes.map((v, i) => {
            const x = (i / (closes.length - 1)) * w;
            const y = h - ((v - min) / range) * h;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(" ");
        const color = isUp ? "#3fb950" : "#f85149";
        svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
    }

    async function refreshWatchlistData() {
        for (let i = 0; i < watchlist.length; i++) {
            const item = watchlist[i];
            try {
                const res = await fetch(`/api/sparkline/${encodeURIComponent(item.displayTicker)}?market=${item.market}`);
                if (res.ok) {
                    const data = await res.json();
                    item.price = data.price;
                    item.changePct = data.changePct;
                    item.closes = data.closes;
                }
            } catch {}
        }
        saveWatchlist();
        renderWatchlist();
    }



    function addToWatchlist() {
        if (!currentTicker) return;
        const exists = watchlist.some(w => w.displayTicker.toUpperCase() === currentTicker.toUpperCase() && w.market === currentMarket);
        if (exists) return;
        const item = { displayTicker: currentTicker.toUpperCase(), ticker: currentTicker.toUpperCase(), market: currentMarket, price: null, changePct: 0, closes: [] };
        watchlist.unshift(item);
        saveWatchlist();
        renderWatchlist();
        fetch(`/api/sparkline/${encodeURIComponent(currentTicker)}?market=${currentMarket}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (!d) return;
                item.price = d.price; item.changePct = d.changePct; item.closes = d.closes; item.ticker = d.ticker;
                saveWatchlist(); renderWatchlist();
            });
    }

    // ── Positions ──

    function loadPositions() {
        try { const p = localStorage.getItem("setTradePositions"); if (p) positions = JSON.parse(p); } catch {}
    }
    function savePositions() { localStorage.setItem("setTradePositions", JSON.stringify(positions)); }

    function posKey(ticker, market) { return `${ticker.toUpperCase()}::${market}`; }

    function getPosition(ticker, market) { return positions[posKey(ticker, market)] || null; }

    function setPosition(ticker, market, shares, avgCost) {
        if (!shares || shares <= 0) { delete positions[posKey(ticker, market)]; }
        else { positions[posKey(ticker, market)] = { ticker: ticker.toUpperCase(), market, shares, avgCost }; }
        savePositions();
    }

    function calcPnl(pos, currentPrice) {
        if (!pos || !currentPrice || !pos.shares || !pos.avgCost) return null;
        const cost = pos.shares * pos.avgCost;
        const value = pos.shares * currentPrice;
        const pnl = value - cost;
        const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
        return { pnl, pnlPct, value, cost };
    }

    function openPositionForm() {
        if (!currentTicker) return;
        const overlay = $("#pos-overlay");
        const pos = getPosition(currentTicker, currentMarket);
        $("#pos-form-ticker").textContent = currentTicker.toUpperCase() + (currentMarket === "set" ? ".BK" : "");
        if (pos) {
            $("#pos-shares").value = pos.shares;
            $("#pos-avg-cost").value = pos.avgCost;
            $("#pos-form-title").textContent = "Edit Position";
            $("#pos-remove").style.display = "";
        } else {
            $("#pos-shares").value = "";
            $("#pos-avg-cost").value = "";
            $("#pos-form-title").textContent = "Add Position";
            $("#pos-remove").style.display = "none";
        }
        overlay.classList.remove("hidden");
        $("#pos-shares").focus();
    }

    function closePositionForm() { $("#pos-overlay").classList.add("hidden"); }

    function savePositionFromForm() {
        const shares = parseFloat($("#pos-shares").value) || 0;
        const avgCost = parseFloat($("#pos-avg-cost").value) || 0;
        setPosition(currentTicker, currentMarket, shares, avgCost);
        closePositionForm();
        updatePriceBarPnl();
        renderWatchlist();
    }

    function removePosition() {
        if (!currentTicker) return;
        delete positions[posKey(currentTicker, currentMarket)];
        savePositions();
        closePositionForm();
        updatePriceBarPnl();
        renderWatchlist();
    }

    function updatePriceBarPnl() {
        const pnlEl = $("#pb-pnl");
        const posBtn = $("#pb-position-btn");
        if (!currentTicker) { pnlEl.classList.add("hidden"); return; }
        const pos = getPosition(currentTicker, currentMarket);
        if (!pos) {
            pnlEl.classList.add("hidden");
            posBtn.classList.remove("has-position");
            posBtn.title = "Add position";
            return;
        }
        posBtn.classList.add("has-position");
        posBtn.title = "Edit position";
        const priceStr = $("#pb-price").textContent;
        const curPrice = parseFloat(priceStr);
        if (!curPrice) { pnlEl.classList.add("hidden"); return; }
        const result = calcPnl(pos, curPrice);
        if (!result) { pnlEl.classList.add("hidden"); return; }
        const sign = result.pnl >= 0 ? "+" : "";
        pnlEl.textContent = `${pos.shares} shares · ${sign}${result.pnlPct.toFixed(1)}% (${sign}${result.pnl.toFixed(2)})`;
        pnlEl.className = `pb-pnl ${result.pnl >= 0 ? "profit" : "loss"}`;
        pnlEl.classList.remove("hidden");
    }

    // ── Charts ──

    const cc = { background: "#161b22", textColor: "#8b949e", gridColor: "rgba(48,54,61,0.5)" };

    function makeChart(container, h) {
        return LightweightCharts.createChart(container, {
            width: container.clientWidth, height: h,
            layout: { background: { type: "solid", color: cc.background }, textColor: cc.textColor, fontFamily: "Inter, sans-serif" },
            grid: { vertLines: { color: cc.gridColor }, horzLines: { color: cc.gridColor } },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: cc.gridColor },
            timeScale: { borderColor: cc.gridColor, timeVisible: false },
        });
    }

    function syncCharts() {
        if (!priceChart || !macdChart || !stochChart) return;
        const charts = [priceChart, macdChart, stochChart];
        charts.forEach((src, si) => {
            src.timeScale().subscribeVisibleLogicalRangeChange(range => {
                if (syncingCrosshair) return;
                syncingCrosshair = true;
                charts.forEach((tgt, ti) => {
                    if (ti !== si && range) tgt.timeScale().setVisibleLogicalRange(range);
                });
                syncingCrosshair = false;
            });
            src.subscribeCrosshairMove(param => {
                if (syncingCrosshair) return;
                syncingCrosshair = true;
                charts.forEach((tgt, ti) => {
                    if (ti !== si) {
                        if (param.time) {
                            tgt.setCrosshairPosition(NaN, param.time, tgt.timeScale());
                        } else {
                            tgt.clearCrosshairPosition();
                        }
                    }
                });
                syncingCrosshair = false;
                updateChartLegends(param);
            });
        });
    }

    function updateChartLegends(param) {
        if (!lastIndicatorData) return;
        const ind = lastIndicatorData;
        const priceLeg = $("#price-chart-legend");
        const macdLeg = $("#macd-chart-legend");
        const stochLeg = $("#stoch-chart-legend");

        if (!param || !param.time) {
            if (priceLeg) updatePriceLegend(priceLeg, ind, -1);
            if (macdLeg) updateMacdLegend(macdLeg, ind, -1);
            if (stochLeg) updateStochLegend(stochLeg, ind, -1);
            return;
        }

        const timeStr = typeof param.time === "object"
            ? `${param.time.year}-${String(param.time.month).padStart(2,"0")}-${String(param.time.day).padStart(2,"0")}`
            : param.time;

        if (priceLeg) updatePriceLegend(priceLeg, ind, timeStr);
        if (macdLeg) updateMacdLegend(macdLeg, ind, timeStr);
        if (stochLeg) updateStochLegend(stochLeg, ind, timeStr);
    }

    function findByTime(arr, t) {
        if (t === -1 && arr.length) return arr[arr.length - 1];
        return arr.find(d => d.time === t);
    }

    function updatePriceLegend(el, ind, t) {
        const ss = findByTime(ind.sma_short, t);
        const sl = findByTime(ind.sma_long, t);
        let h = "";
        if (ss) h += `<span class="cl-item"><span class="cl-dot" style="background:#58a6ff"></span>SMA ${settings.smaShort}: <span class="cl-val">${ss.value.toFixed(2)}</span></span>`;
        if (sl) h += `<span class="cl-item"><span class="cl-dot" style="background:#d29922"></span>SMA ${settings.smaLong}: <span class="cl-val">${sl.value.toFixed(2)}</span></span>`;
        el.innerHTML = h;
    }

    function updateMacdLegend(el, ind, t) {
        const d = findByTime(ind.macd, t);
        if (!d) { el.innerHTML = ""; return; }
        el.innerHTML =
            `<span class="cl-item"><span class="cl-dot" style="background:#58a6ff"></span>MACD: <span class="cl-val">${d.macd.toFixed(4)}</span></span>` +
            `<span class="cl-item"><span class="cl-dot" style="background:#f78166"></span>Signal: <span class="cl-val">${d.signal.toFixed(4)}</span></span>` +
            `<span class="cl-item">Hist: <span class="cl-val" style="color:${d.histogram >= 0 ? "var(--green)" : "var(--red)"}">${d.histogram >= 0 ? "+" : ""}${d.histogram.toFixed(4)}</span></span>`;
    }

    function updateStochLegend(el, ind, t) {
        const d = findByTime(ind.stochastic, t);
        if (!d) { el.innerHTML = ""; return; }
        el.innerHTML =
            `<span class="cl-item"><span class="cl-dot" style="background:#58a6ff"></span>%K: <span class="cl-val">${d.k.toFixed(1)}</span></span>` +
            `<span class="cl-item"><span class="cl-dot" style="background:#f78166"></span>%D: <span class="cl-val">${d.d.toFixed(1)}</span></span>`;
    }

    function renderPriceChart(candles, ind, crossovers) {
        const c = $("#price-chart"); c.innerHTML = "";
        priceChart = makeChart(c, 400);

        const volData = candles.map(d => ({
            time: d.time,
            value: d.volume,
            color: d.close >= d.open ? "rgba(63,185,80,0.25)" : "rgba(248,81,73,0.25)",
        }));
        const volSeries = priceChart.addHistogramSeries({
            priceFormat: { type: "volume" },
            priceScaleId: "vol",
            lastValueVisible: false,
            priceLineVisible: false,
        });
        volSeries.setData(volData);
        priceChart.priceScale("vol").applyOptions({
            scaleMargins: { top: 0.8, bottom: 0 },
            drawTicks: false,
            borderVisible: false,
        });

        const cs = priceChart.addCandlestickSeries({
            upColor: "#3fb950", downColor: "#f85149",
            borderUpColor: "#3fb950", borderDownColor: "#f85149",
            wickUpColor: "#3fb950", wickDownColor: "#f85149",
        });
        cs.setData(candles);
        priceCandleSeries = cs;

        if (ind.sma_short && ind.sma_short.length) { const s = priceChart.addLineSeries({ color: "#58a6ff", lineWidth: 2, lastValueVisible: false, priceLineVisible: false }); s.setData(ind.sma_short); }
        if (ind.sma_long && ind.sma_long.length) { const s = priceChart.addLineSeries({ color: "#d29922", lineWidth: 2, lastValueVisible: false, priceLineVisible: false }); s.setData(ind.sma_long); }

        if (crossovers && crossovers.length) {
            const candleMap = {};
            candles.forEach(c => { candleMap[c.time] = c; });
            const markers = crossovers.filter(m => candleMap[m.time]).map(m => {
                const isBuy = m.type === "buy";
                return {
                    time: m.time,
                    position: isBuy ? "belowBar" : "aboveBar",
                    color: isBuy ? "#3fb950" : "#f85149",
                    shape: isBuy ? "arrowUp" : "arrowDown",
                    text: m.label,
                };
            });
            if (markers.length) cs.setMarkers(markers);
        }

        priceChart.timeScale().fitContent();
    }

    function renderMacdChart(data) {
        const c = $("#macd-chart"); c.innerHTML = "";
        macdChart = makeChart(c, 180);
        const hist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        hist.setData(data.map(d => ({ time: d.time, value: d.histogram, color: d.histogram >= 0 ? "rgba(63,185,80,0.6)" : "rgba(248,81,73,0.6)" })));
        const ml = macdChart.addLineSeries({ color: "#58a6ff", lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
        ml.setData(data.map(d => ({ time: d.time, value: d.macd })));
        const sl = macdChart.addLineSeries({ color: "#f78166", lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
        sl.setData(data.map(d => ({ time: d.time, value: d.signal })));
        macdChart.timeScale().fitContent();
    }

    function renderStochChart(data) {
        const c = $("#stoch-chart"); c.innerHTML = "";
        stochChart = makeChart(c, 180);
        const kl = stochChart.addLineSeries({ color: "#58a6ff", lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
        kl.setData(data.map(d => ({ time: d.time, value: d.k })));
        const dl = stochChart.addLineSeries({ color: "#f78166", lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
        dl.setData(data.map(d => ({ time: d.time, value: d.d })));
        if (data.length) {
            const times = data.map(d => d.time);
            const ob = stochChart.addLineSeries({ color: "rgba(248,81,73,0.3)", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
            const os = stochChart.addLineSeries({ color: "rgba(63,185,80,0.3)", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
            ob.setData(times.map(time => ({ time, value: settings.stochOb })));
            os.setData(times.map(time => ({ time, value: settings.stochOs })));
        }
        stochChart.timeScale().fitContent();
    }

    // ── Signal ──

    const indKeyMap = { "SMA Crossover": "sma", "MACD": "macd", "Stochastic": "stochastic" };

    function recalcSignal(raw) {
        const filtered = raw.reasons.filter(r => { const k = indKeyMap[r.indicator]; return k && activeIndicators.has(k); });
        if (!filtered.length) return { action: "HOLD", reasons: filtered, score: 0, maxScore: 0, allReasons: raw.reasons };
        const sm = { BUY: 1, HOLD: 0, SELL: -1 };
        const score = filtered.reduce((s, r) => s + (sm[r.signal] || 0), 0);
        let action;
        if (settings.sensitivity === "aggressive") { action = score > 0 ? "BUY" : score < 0 ? "SELL" : "HOLD"; }
        else if (settings.sensitivity === "conservative") { action = score === filtered.length ? "BUY" : score === -filtered.length ? "SELL" : "HOLD"; }
        else { action = score > 0 ? "BUY" : score < 0 ? "SELL" : "HOLD"; }
        return { action, reasons: filtered, score, maxScore: filtered.length, allReasons: raw.reasons };
    }

    function renderSignal(signal) {
        lastRawSignal = signal;
        const computed = recalcSignal(signal);
        const cls = computed.action.toLowerCase();

        const card = $("#signal-card");
        card.classList.remove("wash-buy", "wash-sell", "wash-hold");
        card.classList.add(`wash-${cls}`);

        const verdictEl = $("#gauge-verdict");
        const scoreEl = $("#gauge-score");
        const marker = $("#gauge-marker");

        const verdictLabels = { buy: "Bullish", sell: "Bearish", hold: "Neutral" };
        verdictEl.className = `gauge-verdict ${cls}`;
        verdictEl.textContent = verdictLabels[cls] || cls.toUpperCase();

        const maxPossible = computed.allReasons ? computed.allReasons.length : 3;
        const pct = maxPossible > 0 ? ((computed.score + maxPossible) / (2 * maxPossible)) * 100 : 50;
        marker.style.left = `${Math.max(4, Math.min(96, pct))}%`;
        marker.style.background = cls === "buy" ? "var(--green)" : cls === "sell" ? "var(--red)" : "var(--yellow)";
        marker.style.boxShadow = `0 0 0 2px ${cls === "buy" ? "var(--green)" : cls === "sell" ? "var(--red)" : "var(--yellow)"}, 0 2px 8px rgba(0,0,0,0.4)`;

        const activeCount = computed.reasons ? computed.reasons.length : 0;
        const buyCount = computed.reasons ? computed.reasons.filter(r => r.signal === "BUY").length : 0;
        const sellCount = computed.reasons ? computed.reasons.filter(r => r.signal === "SELL").length : 0;
        const holdCount = activeCount - buyCount - sellCount;
        scoreEl.innerHTML = `<span class="score-pills">`
            + (buyCount > 0 ? `<span class="score-pill pill-buy">${buyCount} Buy</span>` : "")
            + (holdCount > 0 ? `<span class="score-pill pill-hold">${holdCount} Hold</span>` : "")
            + (sellCount > 0 ? `<span class="score-pill pill-sell">${sellCount} Sell</span>` : "")
            + `</span>`;

        renderIndicatorCards(computed);
    }

    function renderIndicatorCards(computed) {
        const cardsEl = $("#ind-cards");
        if (!computed.allReasons || !computed.allReasons.length) {
            cardsEl.innerHTML = "";
            return;
        }

        cardsEl.innerHTML = computed.allReasons.map(r => {
            const key = indKeyMap[r.indicator];
            const isActive = key && activeIndicators.has(key);
            const sig = r.signal.toLowerCase();
            const v = r.values || {};

            let valHtml = "";
            if (r.indicator === "SMA Crossover") {
                if (v.shortSma != null) valHtml += `<span class="val-label">Short:</span> ${v.shortSma} `;
                if (v.longSma != null) valHtml += `<span class="val-label">Long:</span> ${v.longSma} `;
                if (v.spread != null) valHtml += `<span class="val-label">Spread:</span> ${v.spread > 0 ? "+" : ""}${v.spread}%`;
            } else if (r.indicator === "MACD") {
                if (v.macd != null) valHtml += `<span class="val-label">MACD:</span> ${v.macd} `;
                if (v.signal != null) valHtml += `<span class="val-label">Sig:</span> ${v.signal} `;
                if (v.histogram != null) valHtml += `<span class="val-label">Hist:</span> ${v.histogram > 0 ? "+" : ""}${v.histogram}`;
            } else if (r.indicator === "Stochastic") {
                if (v.k != null) valHtml += `<span class="val-label">%K:</span> ${v.k} `;
                if (v.d != null) valHtml += `<span class="val-label">%D:</span> ${v.d}`;
            }

            return `<div class="ind-card ${sig} ${isActive ? "" : "disabled"}" data-edu-key="${key}">
                <div class="ind-card-top">
                    <span class="ind-card-name">${r.indicator}</span>
                    <span class="ind-card-chip ${sig}">${t("signal_" + sig)}</span>
                </div>
                <div class="ind-card-values">${valHtml}</div>
                <div class="ind-card-brief">${r.brief || ""}</div>
                <div class="ind-card-learn">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    ${t("edu_learn_more")}
                </div>
            </div>`;
        }).join("");

        cardsEl.querySelectorAll(".ind-card[data-edu-key]").forEach(card => {
            card.addEventListener("click", () => {
                const k = card.dataset.eduKey;
                if (k) showEduPopover(k);
            });
        });
    }

    function updateIndicatorVisibility() {
        const m = { sma: "#sma-chart-container", macd: "#macd-chart-container", stochastic: "#stochastic-chart-container" };
        for (const [k, s] of Object.entries(m)) { const el = $(s); if (el) el.classList.toggle("hidden", !activeIndicators.has(k)); }
        if (lastRawSignal) renderSignal(lastRawSignal);
    }

    // ── Educational Popovers ──

    const EDU_ICONS = {
        sma: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
        macd: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>`,
        stochastic: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
    };

    function getEduCurrentSignal(key) {
        if (!lastRawSignal || !lastRawSignal.reasons) return null;
        const nameMap = { sma: "SMA Crossover", macd: "MACD", stochastic: "Stochastic" };
        return lastRawSignal.reasons.find(r => r.indicator === nameMap[key]) || null;
    }

    function showEduPopover(key) {
        let overlay = $(".metric-tooltip-overlay");
        if (overlay) overlay.remove();

        const prefix = `edu_${key}_`;
        const title = t(prefix + "title");
        const icon = EDU_ICONS[key] || "";

        const reason = getEduCurrentSignal(key);
        let currentHtml = "";
        if (reason) {
            const sig = reason.signal.toLowerCase();
            currentHtml = `<div class="edu-current-signal">
                <span class="edu-signal-dot ${sig}"></span>
                <span><strong>${t("current")}:</strong> ${t("signal_" + sig)} — ${reason.brief || ""}</span>
            </div>`;
        }

        overlay = document.createElement("div");
        overlay.className = "metric-tooltip-overlay";
        overlay.innerHTML = `<div class="edu-popover">
            <div class="edu-header">
                <h3><span class="edu-header-icon">${icon}</span>${title}</h3>
                <button class="edu-close">&times;</button>
            </div>
            <div class="edu-body">
                <div class="edu-section">
                    <div class="edu-section-label">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                        What is it?
                    </div>
                    <p>${t(prefix + "what")}</p>
                </div>
                <div class="edu-section">
                    <div class="edu-section-label">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M4 4h16v13H6.5A2.5 2.5 0 004 19.5V4z"/></svg>
                        ${t("edu_formula")}
                    </div>
                    <p>${t(prefix + "calc")}</p>
                </div>
                <div class="edu-section">
                    <div class="edu-section-label">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        ${t("edu_reading")}
                    </div>
                    <p>${t(prefix + "read")}</p>
                </div>
                <div class="edu-section">
                    <div class="edu-section-label">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        ${t("edu_when_flips")}
                    </div>
                    <p>${t(prefix + "flip")}</p>
                </div>
                ${currentHtml}
            </div>
        </div>`;

        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector(".edu-close").addEventListener("click", close);
        overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
        const onKey = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
        document.addEventListener("keydown", onKey);
    }

    // ── Sticky Price Bar ──

    function updatePriceBar(data) {
        const bar = $("#price-bar");
        if (!data) { bar.classList.add("hidden"); return; }
        bar.classList.remove("hidden");
        $("#pb-ticker").textContent = data.ticker;
        const candles = data.candles;
        if (candles && candles.length) {
            const last = candles[candles.length - 1];
            const prev = candles.length > 1 ? candles[candles.length - 2].close : last.open;
            const chg = ((last.close - prev) / prev * 100);
            const chgSign = chg >= 0 ? "+" : "";
            $("#pb-price").textContent = last.close.toFixed(2);
            const chgEl = $("#pb-change");
            chgEl.textContent = `${chgSign}${chg.toFixed(2)}%`;
            chgEl.className = `pb-change ${chg >= 0 ? "up" : "down"}`;
        }
        if (data.signal) {
            const computed = recalcSignal(data.signal);
            const sigEl = $("#pb-signal");
            const cls = computed.action.toLowerCase();
            sigEl.textContent = computed.action;
            sigEl.className = `pb-signal ${cls}`;
        }
    }

    function updateTimestamp() {
        lastUpdatedTime = new Date();
        const el = $("#pb-updated");
        if (el) {
            el.textContent = `Updated ${lastUpdatedTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
            el.classList.remove("stale");
        }
    }

    function markTimestampStale() {
        const el = $("#pb-updated");
        if (el && lastUpdatedTime) {
            const mins = Math.floor((Date.now() - lastUpdatedTime.getTime()) / 60000);
            if (mins >= 5) el.classList.add("stale");
        }
    }

    async function refreshData() {
        if (!currentTicker) return;
        const btn = $("#pb-refresh");
        btn.classList.add("spinning");
        await doSearch();
        refreshWatchlistData();
        btn.classList.remove("spinning");
    }

    // ── Radar / Snowflake Chart ──

    const radarDimensions = [
        { key: "valuation", label: "Value", color: "#58a6ff" },
        { key: "profitability", label: "Profit", color: "#3fb950" },
        { key: "health", label: "Health", color: "#d29922" },
        { key: "growth", label: "Growth", color: "#f78166" },
        { key: "dividend", label: "Dividend", color: "#bc8cff" },
    ];

    function computeRadarScores(ratios) {
        const scores = {};
        for (const dim of radarDimensions) {
            const group = ratios.find(g => g.category === dim.key);
            if (!group || !group.items.length) { scores[dim.key] = 0; continue; }
            const pts = group.items.map(it => it.verdict === "good" ? 1 : it.verdict === "neutral" ? 0.5 : 0);
            scores[dim.key] = pts.reduce((a, b) => a + b, 0) / pts.length;
        }
        return scores;
    }

    function drawRadar(scores) {
        const canvas = $("#radar-chart");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const w = canvas.width, h = canvas.height;
        const cx = w / 2, cy = h / 2, r = Math.min(cx, cy) - 30;
        ctx.clearRect(0, 0, w, h);

        const n = radarDimensions.length;
        const angleStep = (2 * Math.PI) / n;
        const startAngle = -Math.PI / 2;

        for (let ring = 1; ring <= 4; ring++) {
            const rr = (ring / 4) * r;
            ctx.beginPath();
            for (let i = 0; i <= n; i++) {
                const a = startAngle + i * angleStep;
                const x = cx + rr * Math.cos(a), y = cy + rr * Math.sin(a);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.strokeStyle = "rgba(48,54,61,0.6)";
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        for (let i = 0; i < n; i++) {
            const a = startAngle + i * angleStep;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
            ctx.strokeStyle = "rgba(48,54,61,0.4)";
            ctx.stroke();

            const labelR = r + 16;
            const lx = cx + labelR * Math.cos(a);
            const ly = cy + labelR * Math.sin(a);
            ctx.fillStyle = "#8b949e";
            ctx.font = "11px Inter, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(radarDimensions[i].label, lx, ly);
        }

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const dim = radarDimensions[i];
            const val = scores[dim.key] || 0;
            const a = startAngle + i * angleStep;
            const x = cx + val * r * Math.cos(a);
            const y = cy + val * r * Math.sin(a);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = "rgba(88,166,255,0.15)";
        ctx.fill();
        ctx.strokeStyle = "#58a6ff";
        ctx.lineWidth = 2;
        ctx.stroke();

        for (let i = 0; i < n; i++) {
            const dim = radarDimensions[i];
            const val = scores[dim.key] || 0;
            const a = startAngle + i * angleStep;
            const x = cx + val * r * Math.cos(a);
            const y = cy + val * r * Math.sin(a);
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, 2 * Math.PI);
            ctx.fillStyle = dim.color;
            ctx.fill();
        }

        const legend = $("#radar-legend");
        if (legend) {
            legend.innerHTML = radarDimensions.map(dim => {
                const s = Math.round((scores[dim.key] || 0) * 100);
                return `<span class="radar-legend-item"><span class="radar-legend-dot" style="background:${dim.color}"></span>${dim.label} <span class="radar-legend-score">${s}%</span></span>`;
            }).join("");
        }
    }

    // ── Summary Tab ──

    const categoryLabels = { valuation: "Valuation", profitability: "Profitability", health: "Financial Health", dividend: "Dividend", growth: "Growth" };

    async function fetchSummary(retryCount = 0) {
        const MAX_RETRIES = 2;
        const RETRY_DELAYS = [1500, 3000];
        const key = `${currentTicker}-${currentMarket}`;
        const ticker = currentTicker;
        if (summaryCache[key]) { renderSummary(summaryCache[key]); return; }
        $("#summary-loading").classList.remove("hidden");
        if (retryCount === 0) $("#summary-content").innerHTML = "";
        try {
            const res = await fetchWithTimeout(`/api/summary/${encodeURIComponent(ticker)}?market=${currentMarket}`);
            if (currentTicker !== ticker) return;
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                const err = new Error(d.error || "Failed to load summary");
                err.retryable = d.retryable || res.status >= 500;
                throw err;
            }
            const data = await res.json();
            if (currentTicker !== ticker) return;
            summaryCache[key] = data;
            renderSummary(data);
        } catch (err) {
            if (currentTicker !== ticker) return;
            const isTimeout = err.name === "TimeoutError";
            if (!isTimeout && err.retryable && retryCount < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, RETRY_DELAYS[retryCount] || 2000));
                if (currentTicker === ticker) return fetchSummary(retryCount + 1);
                return;
            }
            const retryBtn = (err.retryable || isTimeout)
                ? ` <button class="retry-btn" onclick="document.dispatchEvent(new CustomEvent('retry-summary'))">Retry</button>`
                : "";
            $("#summary-content").innerHTML = `<div class="error-msg">${err.message}${retryBtn}</div>`;
        } finally {
            if (currentTicker === ticker) $("#summary-loading").classList.add("hidden");
        }
    }
    document.addEventListener("retry-summary", () => { summaryCache = {}; fetchSummary(); });

    function renderSummary(data) {
        const { overview: o, ratios, analyst, industryInfo } = data;
        const changeClass = o.dayChange >= 0 ? "up" : "down";
        const changeSign = o.dayChange >= 0 ? "+" : "";
        const changeStr = o.dayChange != null ? `${changeSign}${o.dayChange.toFixed(2)}%` : "";
        const priceStr = o.price != null ? `${o.currency} ${o.price.toFixed(2)}` : "N/A";

        let html = `<div class="summary-overview"><div class="overview-top">
            <div class="overview-left"><h3>${o.name}</h3><div class="overview-meta">${o.sector} · ${o.industry}</div></div>
            <div class="overview-price"><span class="price">${priceStr}</span><span class="change ${changeClass}">${changeStr}</span></div></div>
            <div class="overview-stats">
                <div class="overview-stat"><div class="stat-label">${t("marketCap")}</div><div class="stat-value">${o.marketCap}</div></div>
                ${o.employees ? `<div class="overview-stat"><div class="stat-label">${t("employees")}</div><div class="stat-value">${o.employees.toLocaleString()}</div></div>` : ""}
            </div>`;

        if (o.fiftyTwoWeekLow != null && o.fiftyTwoWeekHigh != null) {
            const pct = o.fiftyTwoWeekPercent || 0;
            html += `<div class="week52-bar"><div class="week52-label">${t("week52Range")}</div>
                <div class="week52-track"><div class="week52-fill" style="width:${pct}%"></div><div class="week52-marker" style="left:${pct}%"></div></div>
                <div class="week52-range"><span>${o.currency} ${o.fiftyTwoWeekLow.toFixed(2)}</span><span>${o.currency} ${o.fiftyTwoWeekHigh.toFixed(2)}</span></div></div>`;
        }
        html += `</div>`;

        if (industryInfo) {
            html += `<div class="industry-banner">
                <span class="industry-banner-icon">&#9670;</span>
                ${t("industryBenchmark")}: <strong>${industryInfo.name}</strong>
                <span class="industry-peer-count">(${industryInfo.peerCount} ${t("peers")})</span>
            </div>`;
        }

        let ratioIdx = 0;
        const allRatioItems = [];
        for (const group of ratios) {
            const label = categoryLabels[group.category] || group.category;
            html += `<div class="ratio-section"><h4>${t("cat_" + group.category) || label}</h4>`;
            for (const item of group.items) {
                allRatioItems.push(item);
                const hasIndustry = item.industryMedianFmt != null && item.vsIndustry != null;
                const vsSign = item.vsIndustry > 0 ? "+" : "";
                const indBar = hasIndustry ? `<div class="ratio-industry">
                    <span class="ratio-ind-label">${t("indMedian")}: ${item.industryMedianFmt}</span>
                    <span class="ratio-vs ${item.verdict}">${vsSign}${item.vsIndustry.toFixed(1)}%</span>
                </div>` : "";
                html += `<div class="ratio-row verdict-${item.verdict}" data-ratio-idx="${ratioIdx}">
                    <div class="ratio-main">
                        <span class="ratio-label"><span class="ratio-info-icon">i</span>${item.label}</span>
                        <span class="ratio-value">${item.value}</span>
                        <div class="ratio-verdict"><span class="verdict-dot ${item.verdict}"></span><span class="verdict-text ${item.verdict}">${item.description}</span></div>
                    </div>
                    ${indBar}
                </div>`;
                ratioIdx++;
            }
            html += `</div>`;
        }

        if (analyst) {
            const recCls = analyst.recommendation.replace(/\s+/g, "_").toLowerCase();
            html += `<div class="analyst-card"><h4>${t("analystConsensus")}</h4>
                <div class="analyst-rating">
                    <span class="analyst-badge ${recCls}">${analyst.recommendation.toUpperCase()}</span>
                    <span class="analyst-score">${analyst.score ? analyst.score.toFixed(1) + " / 5.0" : ""} ${analyst.numberOfAnalysts ? `(${analyst.numberOfAnalysts} analysts)` : ""}</span>
                </div>
                <div class="analyst-targets">
                    ${analyst.targetMedian ? `<div class="analyst-target"><div class="at-label">${t("targetMedian")}</div><div class="at-value">${o.currency} ${analyst.targetMedian.toFixed(2)}</div></div>` : ""}
                    ${analyst.targetHigh ? `<div class="analyst-target"><div class="at-label">${t("targetHigh")}</div><div class="at-value">${o.currency} ${analyst.targetHigh.toFixed(2)}</div></div>` : ""}
                    ${analyst.targetLow ? `<div class="analyst-target"><div class="at-label">${t("targetLow")}</div><div class="at-value">${o.currency} ${analyst.targetLow.toFixed(2)}</div></div>` : ""}
                </div></div>`;
        }

        $("#summary-content").innerHTML = html;

        $("#summary-content").querySelectorAll(".ratio-row[data-ratio-idx]").forEach(row => {
            row.addEventListener("click", () => {
                const item = allRatioItems[parseInt(row.dataset.ratioIdx)];
                if (item) showMetricTooltip(item);
            });
        });

        const radarScores = computeRadarScores(ratios);
        drawRadar(radarScores);
    }

    function showMetricTooltip(item) {
        let overlay = $(".metric-tooltip-overlay");
        if (overlay) overlay.remove();

        overlay = document.createElement("div");
        overlay.className = "metric-tooltip-overlay";
        const hasInd = item.industryMedianFmt != null;
        const indSection = hasInd ? `<div class="metric-industry-section">
            <span class="metric-ind-badge"><span class="metric-ind-dot"></span>${t("indMedian")}: ${item.industryMedianFmt}</span>
            ${item.vsIndustry != null ? `<span class="metric-vs-badge ${item.verdict}">${item.vsIndustry > 0 ? "+" : ""}${item.vsIndustry.toFixed(1)}% vs industry</span>` : ""}
        </div>` : "";
        overlay.innerHTML = `<div class="metric-tooltip">
            <div class="metric-tooltip-header">
                <h4>${item.label}</h4>
                <button class="metric-tooltip-close">&times;</button>
            </div>
            <div class="metric-tooltip-body">
                <p>${item.tooltip || "No description available."}</p>
                ${indSection}
                <div>
                    ${!hasInd && item.goodRange ? `<span class="metric-good-range"><span class="verdict-dot"></span><span>${t("goodRange")}: ${item.goodRange}</span></span>` : ""}
                    <span class="metric-current-val ${item.verdict}">${t("current")}: ${item.value} — ${item.description}</span>
                </div>
            </div>
        </div>`;

        document.body.appendChild(overlay);
        const close = () => overlay.remove();
        overlay.querySelector(".metric-tooltip-close").addEventListener("click", close);
        overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
        const onKey = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
        document.addEventListener("keydown", onKey);
    }

    // ── Valuation Tab ──

    async function fetchValuation(overrides, retryCount = 0) {
        const MAX_RETRIES = 2;
        const RETRY_DELAYS = [1500, 3000];
        const key = `${currentTicker}-${currentMarket}`;
        const ticker = currentTicker;
        if (!overrides && valuationCache[key]) { renderValuation(valuationCache[key]); return; }
        $("#valuation-loading").classList.remove("hidden");
        if (retryCount === 0) $("#valuation-content").innerHTML = "";
        try {
            let qs = `market=${currentMarket}`;
            if (overrides) {
                for (const [k, v] of Object.entries(overrides)) qs += `&${k}=${v}`;
            }
            const res = await fetchWithTimeout(`/api/valuation/${encodeURIComponent(ticker)}?${qs}`);
            if (currentTicker !== ticker) return;
            if (!res.ok) {
                const d = await res.json().catch(() => ({}));
                const err = new Error(d.error || "Failed to load valuation");
                err.retryable = d.retryable || res.status >= 500;
                throw err;
            }
            const data = await res.json();
            if (currentTicker !== ticker) return;
            if (!overrides) valuationCache[key] = data;
            renderValuation(data);
        } catch (err) {
            if (currentTicker !== ticker) return;
            const isTimeout = err.name === "TimeoutError";
            if (!isTimeout && err.retryable && retryCount < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, RETRY_DELAYS[retryCount] || 2000));
                if (currentTicker === ticker) return fetchValuation(overrides, retryCount + 1);
                return;
            }
            const retryBtn = (err.retryable || isTimeout)
                ? ` <button class="retry-btn" onclick="document.dispatchEvent(new CustomEvent('retry-valuation'))">Retry</button>`
                : "";
            $("#valuation-content").innerHTML = `<div class="error-msg">${err.message}${retryBtn}</div>`;
        } finally {
            if (currentTicker === ticker) $("#valuation-loading").classList.add("hidden");
        }
    }
    document.addEventListener("retry-valuation", () => { valuationCache = {}; fetchValuation(); });

    function fmtNum(n) {
        if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
        if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
        return n.toLocaleString();
    }

    function buildSensitivityTable(data) {
        const a = data.assumptions;
        const baseGrowth = a.growthRate;
        const baseDiscount = a.discountRate;
        const growthSteps = [-4, -2, 0, 2, 4].map(d => +(baseGrowth + d).toFixed(1));
        const discountSteps = [-2, -1, 0, 1, 2].map(d => +(baseDiscount + d).toFixed(1))
            .filter(v => v > 0);

        let html = `<div class="sens-table-card"><h4>${t("sensitivityTable") || "Sensitivity Table"} — ${t("intrinsicValue")}</h4>`;
        html += `<table class="sens-table"><tr><th class="corner">${t("growthRate") || "Growth"} \\ ${t("discountRate") || "WACC"}</th>`;
        for (const dr of discountSteps) html += `<th class="col-header">${dr}%</th>`;
        html += `</tr>`;

        if (data.sensitivityTable) {
            for (let gi = 0; gi < data.sensitivityTable.length; gi++) {
                const row = data.sensitivityTable[gi];
                html += `<tr><td class="row-header">${row.growth}%</td>`;
                for (let di = 0; di < row.values.length; di++) {
                    const v = row.values[di];
                    const upsidePct = ((v - data.currentPrice) / data.currentPrice) * 100;
                    const cls = upsidePct > 10 ? "undervalued" : upsidePct < -10 ? "overvalued" : "fair";
                    const isCurrent = Math.abs(row.growth - baseGrowth) < 0.01 && Math.abs(row.discounts[di] - baseDiscount) < 0.01;
                    html += `<td class="sens-cell ${cls} ${isCurrent ? "current" : ""}">${data.currency} ${v.toFixed(2)}</td>`;
                }
                html += `</tr>`;
            }
        }
        html += `</table></div>`;
        return html;
    }

    function buildWaterfallChart(data) {
        const b = data.breakdown;
        const parse = s => {
            if (!s) return 0;
            const str = String(s).replace(/[^0-9.\-]/g, "");
            const n = parseFloat(str);
            if (isNaN(n)) return 0;
            if (String(s).includes("T")) return n * 1e12;
            if (String(s).includes("B")) return n * 1e9;
            if (String(s).includes("M")) return n * 1e6;
            return n;
        };

        const items = [
            { label: t("pvProjectedFcf"), value: parse(b.pvFcf), type: "positive" },
            { label: t("pvTerminal"), value: parse(b.pvTerminal), type: "positive" },
            { label: t("totalDebt"), value: -parse(b.totalDebt), type: "negative" },
            { label: t("totalCash"), value: parse(b.totalCash), type: "positive" },
            { label: t("equityValue"), value: parse(b.equityValue), type: "total" },
        ];

        const maxVal = Math.max(...items.map(i => Math.abs(i.value)));
        if (maxVal === 0) return "";

        let html = `<div class="waterfall-card"><h4>${t("dcfBreakdown")} — Visual</h4>`;
        for (const item of items) {
            const pct = Math.min(Math.abs(item.value) / maxVal * 100, 100);
            const barCls = item.type === "total" ? "total" : item.value >= 0 ? "positive" : "negative";
            html += `<div class="wf-row">
                <span class="wf-label">${item.label}</span>
                <div class="wf-bar-track"><div class="wf-bar ${barCls}" style="width:${pct}%">${fmtNum(Math.abs(item.value))}</div></div>
            </div>`;
        }
        html += `</div>`;
        return html;
    }

    function renderValuation(data) {
        const a = data.assumptions, b = data.breakdown;
        const upsideCls = data.upside > 10 ? "undervalued" : data.upside < -10 ? "overvalued" : "fair";
        const upsideSign = data.upside >= 0 ? "+" : "";
        const upsideLabel = data.upside > 10 ? t("undervalued") : data.upside < -10 ? t("overvalued") : t("fairValue");

        let html = `<div class="val-result-card">
            <div class="val-prices">
                <div class="val-price-block"><div class="val-price-label">${t("currentPrice")}</div><div class="val-price-value">${data.currency} ${data.currentPrice.toFixed(2)}</div></div>
                <div class="val-vs">→</div>
                <div class="val-price-block"><div class="val-price-label">${t("intrinsicValue")}</div><div class="val-price-value">${data.currency} ${data.intrinsicValue.toFixed(2)}</div></div>
            </div>
            <div class="val-upside ${upsideCls}">${upsideSign}${data.upside.toFixed(1)}% · ${upsideLabel}</div>
        </div>`;

        html += `<details class="val-assumptions" id="val-assumptions">
            <summary>${t("adjustAssumptions")}</summary>
            <div class="val-assumptions-body">
                <div class="val-assumption-row"><label>${t("growthRate")}</label><input type="number" id="val-growth" value="${a.growthRate}" step="0.5" min="-30" max="40">%</div>
                <div class="val-assumption-row"><label>${t("discountRate")}</label><input type="number" id="val-discount" value="${a.discountRate}" step="0.5" min="1" max="30">%</div>
                <div class="val-assumption-row"><label>${t("terminalGrowth")}</label><input type="number" id="val-terminal" value="${a.terminalGrowth}" step="0.5" min="0" max="5">%</div>
                <div class="val-assumption-row"><label>${t("projYears")}</label><input type="number" id="val-years" value="${a.projectionYears}" step="1" min="3" max="10"></div>
                <div class="val-recalc-row"><button class="btn-primary btn-sm" id="val-recalc">${t("recalculate")}</button></div>
            </div>
        </details>`;

        html += buildSensitivityTable(data);

        html += buildWaterfallChart(data);

        html += `<div class="val-table"><h4>${t("projectedFcf")}</h4><table>
            <tr><th>${t("year")}</th><th class="num">${t("projFcf")}</th><th class="num">${t("presentValue")}</th></tr>`;
        if (data.history && data.history.years) {
            for (let i = 0; i < data.history.years.length; i++) {
                html += `<tr style="opacity:0.6"><td>${data.history.years[i]} (actual)</td><td class="num">${fmtNum(data.history.fcf[i])}</td><td class="num">—</td></tr>`;
            }
        }
        for (const p of data.projections) {
            html += `<tr><td>Year ${p.year}</td><td class="num">${fmtNum(p.fcf)}</td><td class="num">${fmtNum(p.pv)}</td></tr>`;
        }
        html += `</table></div>`;

        html += `<div class="val-breakdown"><h4>${t("dcfBreakdown")}</h4>
            <div class="val-bk-row"><span class="val-bk-label">${t("pvProjectedFcf")}</span><span class="val-bk-value">${b.pvFcf}</span></div>
            <div class="val-bk-row"><span class="val-bk-label">${t("pvTerminal")}</span><span class="val-bk-value">${b.pvTerminal}</span></div>
            <div class="val-bk-row"><span class="val-bk-label">${t("enterpriseValue")}</span><span class="val-bk-value">${b.enterpriseValue}</span></div>
            <div class="val-bk-row"><span class="val-bk-label">- ${t("totalDebt")}</span><span class="val-bk-value">${b.totalDebt}</span></div>
            <div class="val-bk-row"><span class="val-bk-label">+ ${t("totalCash")}</span><span class="val-bk-value">${b.totalCash}</span></div>
            <div class="val-bk-row total"><span class="val-bk-label">${t("equityValue")}</span><span class="val-bk-value">${b.equityValue}</span></div>
            <div class="val-bk-row"><span class="val-bk-label">${t("sharesOutstanding")}</span><span class="val-bk-value">${b.sharesOutstanding}</span></div>
        </div>`;

        $("#valuation-content").innerHTML = html;

        const recalcBtn = $("#val-recalc");
        if (recalcBtn) {
            recalcBtn.addEventListener("click", () => {
                fetchValuation({
                    growth_rate: parseFloat($("#val-growth").value),
                    discount_rate: parseFloat($("#val-discount").value),
                    terminal_growth: parseFloat($("#val-terminal").value),
                    projection_years: parseInt($("#val-years").value),
                });
            });
        }
    }


    // ── Backtest ──

    let btChart = null;
    let backtestCache = {};

    function getBtConfig() {
        const period = $("#bt-cfg-period") ? $("#bt-cfg-period").value : currentPeriod;
        const sensitivity = $("#bt-cfg-sensitivity") ? $("#bt-cfg-sensitivity").value : settings.sensitivity;
        const inds = [];
        if ($("#bt-ind-sma") && $("#bt-ind-sma").checked) inds.push("sma");
        if ($("#bt-ind-macd") && $("#bt-ind-macd").checked) inds.push("macd");
        if ($("#bt-ind-stochastic") && $("#bt-ind-stochastic").checked) inds.push("stochastic");
        const minHold = parseInt($("#bt-min-hold") ? $("#bt-min-hold").value : 0) || 0;
        const cooldown = parseInt($("#bt-cooldown") ? $("#bt-cooldown").value : 0) || 0;
        const confirmDays = parseInt($("#bt-confirm") ? $("#bt-confirm").value : 1) || 1;
        return { period, sensitivity, inds, minHold, cooldown, confirmDays };
    }

    function populateBtConfig() {
        const cfgTicker = $("#bt-cfg-ticker");
        if (!cfgTicker) return;
        cfgTicker.textContent = currentTicker ? currentTicker.toUpperCase() : "\u2014";

        const periodSel = $("#bt-cfg-period");
        if (periodSel) periodSel.value = currentPeriod;

        const sensSel = $("#bt-cfg-sensitivity");
        if (sensSel) sensSel.value = settings.sensitivity;

        if ($("#bt-ind-sma")) $("#bt-ind-sma").checked = activeIndicators.has("sma");
        if ($("#bt-ind-macd")) $("#bt-ind-macd").checked = activeIndicators.has("macd");
        if ($("#bt-ind-stochastic")) $("#bt-ind-stochastic").checked = activeIndicators.has("stochastic");

        updateBtRules();
    }

    function updateBtRules() {
        const cfg = getBtConfig();
        const cfgRules = $("#bt-cfg-rules");
        if (!cfgRules) return;

        const nameMap = { sma: "SMA Crossover", macd: "MACD", stochastic: "Stochastic" };
        const indNames = cfg.inds.map(k => nameMap[k] || k);

        let ruleText = "";
        if (indNames.length === 0) {
            ruleText = t("bt_rule_none");
        } else if (cfg.sensitivity === "aggressive") {
            ruleText = t("bt_rule_aggressive").replace("{ind}", indNames.join(", "));
        } else if (cfg.sensitivity === "conservative") {
            ruleText = t("bt_rule_conservative").replace("{ind}", indNames.join(" + "));
        } else {
            ruleText = t("bt_rule_normal").replace("{ind}", indNames.join(", "));
        }

        const extras = [];
        if (cfg.minHold > 0) extras.push(t("bt_rule_hold").replace("{n}", cfg.minHold));
        if (cfg.cooldown > 0) extras.push(t("bt_rule_cooldown").replace("{n}", cfg.cooldown));
        if (cfg.confirmDays > 1) extras.push(t("bt_rule_confirm").replace("{n}", cfg.confirmDays));
        if (extras.length) ruleText += " " + extras.join(" ");

        cfgRules.innerHTML = `<div class="bt-rule-box"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg><span>${ruleText}</span></div>`;
    }

    async function fetchBacktest() {
        if (!currentTicker) return;
        const cfg = getBtConfig();
        if (cfg.inds.length === 0) { $("#bt-empty").classList.remove("hidden"); $("#bt-results").classList.add("hidden"); return; }
        $("#backtest-loading").classList.remove("hidden");
        $("#bt-results").classList.add("hidden");
        $("#bt-empty").classList.add("hidden");
        try {
            const qs = `market=${currentMarket}&period=${cfg.period}&active=${cfg.inds.join(",")}&sensitivity=${cfg.sensitivity}`
                + `&min_hold=${cfg.minHold}&cooldown=${cfg.cooldown}&confirm_days=${cfg.confirmDays}`
                + settingsToQuery();
            const res = await fetch(`/api/backtest/${encodeURIComponent(currentTicker)}?${qs}`);
            if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Backtest failed"); }
            const data = await res.json();
            renderBacktest(data);
        } catch (err) {
            $("#bt-results").classList.remove("hidden");
            $("#bt-metrics").innerHTML = `<div class="error-msg">${err.message}</div>`;
        } finally {
            $("#backtest-loading").classList.add("hidden");
        }
    }

    function renderBacktest(data) {
        const m = data.metrics;
        const trades = data.trades || [];
        const closedTrades = trades.filter(tr => tr.result !== "open");

        if (closedTrades.length === 0) {
            $("#bt-results").classList.add("hidden");
            $("#bt-empty").classList.remove("hidden");
            return;
        }
        $("#bt-empty").classList.add("hidden");

        const activeNames = (data.activeIndicators || []).map(k => k === "sma" ? "SMA" : k === "macd" ? "MACD" : "Stochastic");
        const sensLabel = { conservative: t("conservative"), normal: t("normal"), aggressive: t("aggressive") }[data.sensitivity] || data.sensitivity || "";

        const stratEl = $("#bt-strategy-label");
        stratEl.innerHTML = `<span class="bt-strat-name">${activeNames.join(" + ")}</span>`
            + `<span class="bt-strat-ticker">${data.name || data.ticker}</span>`
            + `<span class="bt-strat-period">${data.period.toUpperCase()}</span>`
            + (sensLabel ? `<span class="bt-strat-sens">${sensLabel}</span>` : "")
            + `<span class="bt-strat-trades">${m.numTrades} ${t("bt_trades_count")}</span>`;

        const metricsEl = $("#bt-metrics");
        const verdict = m.totalReturn > m.buyHoldReturn ? "green" : m.totalReturn < m.buyHoldReturn ? "red" : "neutral";
        const metrics = [
            { key: "bt_total_return", val: fmtPct(m.totalReturn), color: m.totalReturn >= 0 ? "green" : "red", big: true },
            { key: "bt_buy_hold", val: fmtPct(m.buyHoldReturn), color: m.buyHoldReturn >= 0 ? "green" : "red", big: true },
            { key: "bt_outperformance", val: fmtPct(m.outperformance), color: verdict, big: true },
            { key: "bt_win_rate", val: `${m.winRate}%`, color: m.winRate >= 50 ? "green" : "red" },
            { key: "bt_avg_win", val: fmtPct(m.avgWin), color: "green" },
            { key: "bt_avg_loss", val: fmtPct(m.avgLoss), color: "red" },
            { key: "bt_max_dd", val: fmtPct(-m.maxDrawdown), color: "red" },
            { key: "bt_sharpe", val: m.sharpe.toFixed(2), color: m.sharpe >= 1 ? "green" : m.sharpe >= 0 ? "neutral" : "red" },
            { key: "bt_profit_factor", val: m.profitFactor >= 999 ? "\u221e" : m.profitFactor.toFixed(2), color: m.profitFactor >= 1.5 ? "green" : "red" },
            { key: "bt_avg_hold", val: `${m.avgHoldDays.toFixed(0)}d`, color: "neutral" },
            { key: "bt_wins_losses", val: `${m.numWins}W / ${m.numLosses}L`, color: "neutral" },
            { key: "bt_num_trades", val: m.numTrades, color: "neutral" },
        ];
        metricsEl.innerHTML = metrics.map(mc => `<div class="bt-metric-card${mc.big ? " bt-metric-big" : ""}">
            <div class="bt-metric-label">${t(mc.key)}</div>
            <div class="bt-metric-value bt-${mc.color}">${mc.val}</div>
        </div>`).join("");

        renderEquityCurve(data.equityCurve, data.buyHoldCurve);

        const tbody = $("#bt-trades-body");
        tbody.innerHTML = trades.map((tr, i) => {
            const cls = tr.result === "win" ? "bt-win" : tr.result === "loss" ? "bt-loss" : "bt-open";
            return `<tr class="${cls}">
                <td>${i + 1}</td>
                <td>${tr.entryDate}</td>
                <td>${tr.exitDate}</td>
                <td>${tr.entryPrice.toFixed(2)}</td>
                <td>${tr.exitPrice.toFixed(2)}</td>
                <td class="${tr.pnlPct >= 0 ? "clr-green" : "clr-red"}">${fmtPct(tr.pnlPct)}</td>
                <td>${tr.holdDays}</td>
                <td><span class="bt-result-chip ${cls}">${tr.result === "open" ? t("bt_open") : tr.result === "win" ? t("bt_win") : t("bt_loss_label")}</span></td>
            </tr>`;
        }).join("");

        $("#bt-results").classList.remove("hidden");
    }

    function fmtPct(val) {
        const sign = val >= 0 ? "+" : "";
        return `${sign}${val.toFixed(2)}%`;
    }

    function renderEquityCurve(equityCurve, buyHoldCurve) {
        const container = $("#bt-equity-chart");
        container.innerHTML = "";
        if (!equityCurve || !equityCurve.length) return;

        if (btChart) { btChart.remove(); btChart = null; }

        btChart = LightweightCharts.createChart(container, {
            width: container.clientWidth,
            height: 320,
            layout: { background: { type: "solid", color: "transparent" }, textColor: "#8b949e", fontFamily: "Inter, sans-serif" },
            grid: { vertLines: { color: "rgba(48,54,61,0.3)" }, horzLines: { color: "rgba(48,54,61,0.3)" } },
            rightPriceScale: { borderColor: "#30363d" },
            timeScale: { borderColor: "#30363d", timeVisible: false },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        });

        const strategySeries = btChart.addLineSeries({
            color: "#58a6ff",
            lineWidth: 2,
            title: "Strategy",
        });
        strategySeries.setData(equityCurve);

        const bhSeries = btChart.addLineSeries({
            color: "#8b949e",
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            title: "Buy & Hold",
        });
        bhSeries.setData(buyHoldCurve);

        btChart.timeScale().fitContent();

        const ro = new ResizeObserver(() => {
            if (btChart && container.clientWidth > 0) {
                btChart.applyOptions({ width: container.clientWidth });
            }
        });
        ro.observe(container);
    }

    // ── Portfolio ──

    let portfolioOpen = false;

    function togglePortfolio() {
        portfolioOpen = !portfolioOpen;
        $("#portfolio-btn").classList.toggle("active", portfolioOpen);
        $("#portfolio-view").classList.toggle("hidden", !portfolioOpen);
        if (!portfolioOpen) return;
        hideWelcome();
        $("#results").classList.add("hidden");
        $("#alerts-view").classList.add("hidden");
        $("#paper-view").classList.add("hidden");
        if (compareMode) { toggleCompare(); }
        fetchPortfolio();
    }

    function closePortfolio() {
        portfolioOpen = false;
        $("#portfolio-btn").classList.remove("active");
        $("#portfolio-view").classList.add("hidden");
    }

    async function fetchPortfolio() {
        const posList = Object.values(positions);
        if (!posList.length) {
            $("#portfolio-empty").classList.remove("hidden");
            $("#portfolio-content").innerHTML = "";
            return;
        }
        $("#portfolio-empty").classList.add("hidden");
        $("#portfolio-loading").classList.remove("hidden");
        $("#portfolio-content").innerHTML = "";

        try {
            const res = await fetch("/api/portfolio", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(posList),
            });
            if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed to load portfolio"); }
            const data = await res.json();
            renderPortfolio(data);
        } catch (err) {
            $("#portfolio-content").innerHTML = `<div class="error-msg">${err.message}</div>`;
        } finally {
            $("#portfolio-loading").classList.add("hidden");
        }
    }

    function renderPortfolio(data) {
        const pSign = data.totalPnl >= 0 ? "+" : "";
        const pCls = data.totalPnl >= 0 ? "profit" : "loss";
        const dSign = data.totalDayPnl >= 0 ? "+" : "";
        const dCls = data.totalDayPnl >= 0 ? "profit" : "loss";

        let html = `<div class="pf-summary-cards">
            <div class="pf-card">
                <div class="pf-card-label">Total Value</div>
                <div class="pf-card-value">${fmtCurrency(data.totalValue)}</div>
            </div>
            <div class="pf-card">
                <div class="pf-card-label">Total Cost</div>
                <div class="pf-card-value">${fmtCurrency(data.totalCost)}</div>
            </div>
            <div class="pf-card ${pCls}">
                <div class="pf-card-label">Total P&L</div>
                <div class="pf-card-value">${pSign}${fmtCurrency(data.totalPnl)} <span class="pf-card-pct">(${pSign}${data.totalPnlPct.toFixed(1)}%)</span></div>
            </div>
            <div class="pf-card ${dCls}">
                <div class="pf-card-label">Day P&L</div>
                <div class="pf-card-value">${dSign}${fmtCurrency(data.totalDayPnl)}</div>
            </div>
        </div>`;

        html += `<div class="pf-body-layout">`;

        // Holdings table
        html += `<div class="pf-holdings-wrap">
            <h3>Holdings</h3>
            <div class="pf-table-scroll">
            <table class="pf-table">
                <thead><tr>
                    <th>Stock</th>
                    <th class="num">Price</th>
                    <th class="num">Shares</th>
                    <th class="num">Avg Cost</th>
                    <th class="num">Value</th>
                    <th class="num">P&L</th>
                    <th class="num">Day</th>
                    <th class="num">Weight</th>
                </tr></thead>
                <tbody>`;

        const sorted = [...data.holdings].sort((a, b) => b.value - a.value);
        for (const h of sorted) {
            const hpSign = h.pnl >= 0 ? "+" : "";
            const hpCls = h.pnl >= 0 ? "profit" : "loss";
            const hdSign = h.dayChange >= 0 ? "+" : "";
            const hdCls = h.dayChange >= 0 ? "profit" : "loss";
            html += `<tr class="pf-row" data-ticker="${h.ticker}" data-market="${h.market}">
                <td>
                    <div class="pf-stock-name">${h.ticker}</div>
                    <div class="pf-stock-meta">${h.sector}</div>
                </td>
                <td class="num">${h.price.toFixed(2)}</td>
                <td class="num">${h.shares}</td>
                <td class="num">${h.avgCost.toFixed(2)}</td>
                <td class="num">${fmtCurrency(h.value)}</td>
                <td class="num ${hpCls}">${hpSign}${fmtCurrency(h.pnl)}<br><span class="pf-small">${hpSign}${h.pnlPct.toFixed(1)}%</span></td>
                <td class="num ${hdCls}">${hdSign}${h.dayChange.toFixed(1)}%</td>
                <td class="num">${h.weight}%</td>
            </tr>`;
        }
        html += `</tbody></table></div></div>`;

        // Sector allocation
        html += `<div class="pf-allocation">
            <h3>Sector Allocation</h3>
            <canvas id="pf-pie" width="220" height="220"></canvas>
            <div class="pf-sector-list" id="pf-sector-list">`;
        for (const s of data.sectors) {
            html += `<div class="pf-sector-row">
                <span class="pf-sector-dot" style="background:${sectorColor(s.name)}"></span>
                <span class="pf-sector-name">${s.name}</span>
                <span class="pf-sector-pct">${s.pct}%</span>
            </div>`;
        }
        html += `</div>`;

        // Key metrics
        const avgPE = weightedAvg(data.holdings, "pe", "value");
        const avgDiv = weightedAvg(data.holdings, "divYield", "value");
        const avgBeta = weightedAvg(data.holdings, "beta", "value");
        html += `<div class="pf-metrics">
            <h3>Portfolio Metrics</h3>
            <div class="pf-metric-row"><span>Wtd Avg P/E</span><span class="pf-metric-val">${avgPE ? avgPE.toFixed(1) : "N/A"}</span></div>
            <div class="pf-metric-row"><span>Wtd Avg Div Yield</span><span class="pf-metric-val">${avgDiv ? avgDiv.toFixed(2) + "%" : "N/A"}</span></div>
            <div class="pf-metric-row"><span>Wtd Avg Beta</span><span class="pf-metric-val">${avgBeta ? avgBeta.toFixed(2) : "N/A"}</span></div>
            <div class="pf-metric-row"><span>Holdings</span><span class="pf-metric-val">${data.holdings.length}</span></div>
            <div class="pf-metric-row"><span>Sectors</span><span class="pf-metric-val">${data.sectors.length}</span></div>
        </div>`;

        html += `</div>`;

        $("#portfolio-content").innerHTML = html;

        drawPieChart(data.sectors);

        $("#portfolio-content").querySelectorAll(".pf-row").forEach(row => {
            row.addEventListener("click", () => {
                const tk = row.dataset.ticker;
                const mk = row.dataset.market;
                closePortfolio();
                if (mk !== currentMarket) {
                    currentMarket = mk;
                    $$(".btn-market-pill").forEach(b => b.classList.toggle("active", b.dataset.market === currentMarket));
                }
                $("#ticker-input").value = tk;
                doSearch();
            });
        });
    }

    function fmtCurrency(n) {
        if (Math.abs(n) >= 1e6) return fmtNum(Math.abs(n));
        return Math.abs(n) < 0.01 ? "0.00" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function weightedAvg(holdings, key, weightKey) {
        let num = 0, den = 0;
        for (const h of holdings) {
            if (h[key] != null) { num += h[key] * h[weightKey]; den += h[weightKey]; }
        }
        return den > 0 ? num / den : null;
    }

    const SECTOR_COLORS = [
        "#58a6ff", "#3fb950", "#f78166", "#d29922", "#bc8cff",
        "#f85149", "#79c0ff", "#56d364", "#e3b341", "#db61a2",
        "#8b949e", "#6cb6ff", "#7ee787", "#d2a8ff", "#ff7b72",
    ];
    function sectorColor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        return SECTOR_COLORS[Math.abs(hash) % SECTOR_COLORS.length];
    }

    function drawPieChart(sectors) {
        const canvas = $("#pf-pie");
        if (!canvas || !sectors.length) return;
        const ctx = canvas.getContext("2d");
        const w = canvas.width, h = canvas.height;
        const cx = w / 2, cy = h / 2, r = Math.min(cx, cy) - 10;
        const innerR = r * 0.55;
        ctx.clearRect(0, 0, w, h);

        const total = sectors.reduce((s, x) => s + x.value, 0);
        if (total <= 0) return;
        let angle = -Math.PI / 2;

        for (const s of sectors) {
            const slice = (s.value / total) * 2 * Math.PI;
            ctx.beginPath();
            ctx.arc(cx, cy, r, angle, angle + slice);
            ctx.arc(cx, cy, innerR, angle + slice, angle, true);
            ctx.closePath();
            ctx.fillStyle = sectorColor(s.name);
            ctx.fill();
            angle += slice;
        }

        ctx.fillStyle = "#8b949e";
        ctx.font = "bold 13px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${sectors.length}`, cx, cy - 7);
        ctx.font = "10px Inter, sans-serif";
        ctx.fillText("sectors", cx, cy + 8);
    }

    // ── Compare Mode ──

    function toggleCompare() {
        compareMode = !compareMode;
        $("#compare-toggle").classList.toggle("active", compareMode);
        $("#compare-banner").classList.toggle("hidden", !compareMode);
        if (!compareMode) {
            $("#compare-results").classList.add("hidden");
            $("#compare-results").innerHTML = "";
        }
        if (compareMode && currentTicker) {
            $("#compare-ticker-a").value = currentTicker;
        }
    }

    async function fetchCompareData(ticker) {
        const [stockRes, summaryRes] = await Promise.all([
            fetch(`/api/stock/${encodeURIComponent(ticker)}?period=${currentPeriod}&market=${currentMarket}${settingsToQuery()}`),
            fetch(`/api/summary/${encodeURIComponent(ticker)}?market=${currentMarket}`)
        ]);
        if (!stockRes.ok || !summaryRes.ok) return null;
        const stock = await stockRes.json();
        const summary = await summaryRes.json();
        return { stock, summary };
    }

    async function doCompare() {
        const a = $("#compare-ticker-a").value.trim();
        const b = $("#compare-ticker-b").value.trim();
        if (!a || !b) return;
        const cr = $("#compare-results");
        cr.classList.remove("hidden");
        cr.innerHTML = `<div class="loading"><div class="spinner"></div><span>Loading comparison...</span></div>`;

        try {
            const [dataA, dataB] = await Promise.all([fetchCompareData(a), fetchCompareData(b)]);
            if (!dataA || !dataB) { cr.innerHTML = `<div class="error-msg">Could not load data for both stocks.</div>`; return; }
            renderCompare(dataA, dataB);
        } catch (err) {
            cr.innerHTML = `<div class="error-msg">${err.message}</div>`;
        }
    }

    function renderCompare(a, b) {
        const cr = $("#compare-results");
        function buildCol(data) {
            const s = data.stock, sum = data.summary;
            const sigAction = recalcSignal(s.signal).action.toLowerCase();
            const o = sum.overview;
            const priceStr = o.price != null ? `${o.currency} ${o.price.toFixed(2)}` : "N/A";
            const chg = o.dayChange != null ? `${o.dayChange >= 0 ? "+" : ""}${o.dayChange.toFixed(2)}%` : "";

            let html = `<div class="compare-col">
                <div class="compare-col-header"><h3>${s.name}</h3><span class="compare-signal-mini ${sigAction}">${sigAction.toUpperCase()}</span></div>
                <div class="compare-metric"><span class="compare-metric-label">${t("currentPrice")}</span><span class="compare-metric-value">${priceStr} ${chg}</span></div>
                <div class="compare-metric"><span class="compare-metric-label">${t("marketCap")}</span><span class="compare-metric-value">${o.marketCap}</span></div>`;

            for (const group of sum.ratios) {
                for (const item of group.items) {
                    if (item.value === "N/A") continue;
                    html += `<div class="compare-metric"><span class="compare-metric-label">${item.label}</span><span class="compare-metric-value"><span class="verdict-dot ${item.verdict}" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>${item.value}</span></div>`;
                }
            }
            html += `</div>`;
            return html;
        }
        cr.innerHTML = buildCol(a) + buildCol(b);
    }

    // ── Search ──

    async function doSearch() {
        const ticker = $("#ticker-input").value.trim();
        if (!ticker) return;
        currentTicker = ticker;
        if (compareMode) return;
        if (portfolioOpen) closePortfolio();
        hideWelcome();
        $("#loading").classList.remove("hidden");
        $("#error-msg").classList.add("hidden");
        $("#results").classList.add("hidden");
        $("#search-btn").disabled = true;
        $("#watchlist-add").classList.remove("hidden");

        if (searchAbort) searchAbort.abort();
        searchAbort = new AbortController();
        const mySeq = ++searchSeq;

        try {
            const url = `/api/stock/${encodeURIComponent(ticker)}?period=${currentPeriod}&market=${currentMarket}${settingsToQuery()}`;
            const res = await fetchWithTimeout(url, { signal: searchAbort.signal }, 20000);
            if (mySeq !== searchSeq) return;
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t("fetchError")); }
            const data = await res.json();
            if (mySeq !== searchSeq) return;
            $("#stock-name").textContent = data.name;
            $("#stock-ticker").textContent = data.ticker;
            $("#results").classList.remove("hidden");
            lastIndicatorData = data.indicators;
            renderPriceChart(data.candles, data.indicators, data.signal.crossovers);
            renderMacdChart(data.indicators.macd);
            renderStochChart(data.indicators.stochastic);
            syncCharts();
            updateChartLegends({ time: null });
            renderSignal(data.signal);
            updateIndicatorVisibility();
            updatePriceBar(data);
            updatePriceBarPnl();
            updateTimestamp();
            renderWatchlist();
            const sKey = `${currentTicker}-${currentMarket}`;
            if (!summaryCache[sKey]) {
                fetch(`/api/summary/${encodeURIComponent(ticker)}?market=${currentMarket}`)
                    .then(r => r.ok ? r.json() : null).then(d => { if (d && !d.error) summaryCache[sKey] = d; }).catch(() => {});
            }
            if (!valuationCache[sKey]) {
                fetch(`/api/valuation/${encodeURIComponent(ticker)}?market=${currentMarket}`)
                    .then(r => r.ok ? r.json() : null).then(d => { if (d && !d.error) valuationCache[sKey] = d; }).catch(() => {});
            }
        } catch (err) {
            if (err.name === "AbortError") return;
            if (mySeq !== searchSeq) return;
            $("#error-msg").textContent = err.message;
            $("#error-msg").classList.remove("hidden");
        } finally {
            if (mySeq === searchSeq) {
                $("#loading").classList.add("hidden");
                $("#search-btn").disabled = false;
            }
        }
    }

    // ── Autocomplete ──

    let acDebounce = null;
    let acResults = [];
    let acIndex = -1;

    function showAutocomplete(items) {
        const dd = $("#autocomplete-dropdown");
        acResults = items;
        acIndex = -1;
        if (!items.length) { dd.classList.add("hidden"); dd.innerHTML = ""; return; }
        dd.classList.remove("hidden");
        dd.innerHTML = items.map((item, i) =>
            `<div class="ac-item" data-idx="${i}">
                <span class="ac-symbol">${item.symbol}</span>
                <span class="ac-name">${item.name}</span>
                <span class="ac-exchange">${item.exchange}</span>
            </div>`
        ).join("");
        dd.querySelectorAll(".ac-item").forEach(el => {
            el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                selectAutocomplete(parseInt(el.dataset.idx));
            });
        });
    }

    function selectAutocomplete(idx) {
        const item = acResults[idx];
        if (!item) return;
        $("#ticker-input").value = item.symbol;
        hideAutocomplete();
        doSearch();
    }

    function hideAutocomplete() {
        $("#autocomplete-dropdown").classList.add("hidden");
        $("#autocomplete-dropdown").innerHTML = "";
        acResults = [];
        acIndex = -1;
    }

    function handleAutocompleteNav(e) {
        const dd = $("#autocomplete-dropdown");
        if (dd.classList.contains("hidden") || !acResults.length) return false;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            acIndex = Math.min(acIndex + 1, acResults.length - 1);
            highlightAcItem();
            return true;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            acIndex = Math.max(acIndex - 1, 0);
            highlightAcItem();
            return true;
        }
        if (e.key === "Enter" && acIndex >= 0) {
            e.preventDefault();
            selectAutocomplete(acIndex);
            return true;
        }
        if (e.key === "Escape") {
            hideAutocomplete();
            return true;
        }
        return false;
    }

    function highlightAcItem() {
        const dd = $("#autocomplete-dropdown");
        dd.querySelectorAll(".ac-item").forEach((el, i) => {
            el.classList.toggle("active", i === acIndex);
        });
        const active = dd.querySelector(".ac-item.active");
        if (active) active.scrollIntoView({ block: "nearest" });
    }

    async function fetchAutocomplete(query) {
        if (query.length < 1) { hideAutocomplete(); return; }
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&market=${currentMarket}`);
            if (!res.ok) { hideAutocomplete(); return; }
            const data = await res.json();
            if ($("#ticker-input").value.trim().toUpperCase() !== query.toUpperCase()) return;
            showAutocomplete(data);
        } catch {
            hideAutocomplete();
        }
    }

    // ── Resize ──
    function handleResize() {
        if (priceChart) priceChart.applyOptions({ width: $("#price-chart").clientWidth });
        if (macdChart) macdChart.applyOptions({ width: $("#macd-chart").clientWidth });
        if (stochChart) stochChart.applyOptions({ width: $("#stoch-chart").clientWidth });
    }

    // ── Welcome / Home ──

    const TYPEWRITER_PHRASES = [
        "Analyzing PTT.BK — Signal: BUY",
        "Running DCF on AAPL — 18.2% upside",
        "Scanning SET market for opportunities",
        "Checking MACD crossover on AOT.BK",
        "Portfolio P&L today: +2.4%",
        "TSLA Stochastic exiting oversold zone",
    ];

    let twIdx = 0;
    let twCharIdx = 0;
    let twDeleting = false;
    let twTimeout = null;

    function typewriterTick() {
        const el = $("#tw-text");
        if (!el) return;
        const phrase = TYPEWRITER_PHRASES[twIdx % TYPEWRITER_PHRASES.length];

        if (!twDeleting) {
            twCharIdx++;
            el.textContent = phrase.slice(0, twCharIdx);
            if (twCharIdx >= phrase.length) {
                twTimeout = setTimeout(() => { twDeleting = true; typewriterTick(); }, 2200);
                return;
            }
            twTimeout = setTimeout(typewriterTick, 45 + Math.random() * 35);
        } else {
            twCharIdx--;
            el.textContent = phrase.slice(0, twCharIdx);
            if (twCharIdx <= 0) {
                twDeleting = false;
                twIdx++;
                twTimeout = setTimeout(typewriterTick, 400);
                return;
            }
            twTimeout = setTimeout(typewriterTick, 20);
        }
    }

    function initScrollReveals() {
        const cards = $$(".wf-card[data-reveal]");
        if (!cards.length) return;
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry, i) => {
                if (entry.isIntersecting) {
                    setTimeout(() => entry.target.classList.add("revealed"), i * 80);
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.15 });
        cards.forEach(c => observer.observe(c));
    }

    function showWelcome() {
        const welcome = $("#welcome");
        if (welcome) welcome.classList.remove("hidden");
        $("#search-section").classList.add("hidden");
        $("#results").classList.add("hidden");
        $("#price-bar").classList.add("hidden");
        if (portfolioOpen) closePortfolio();
        if (compareMode) toggleCompare();
        initBurstCanvas();
    }

    function hideWelcome() {
        const welcome = $("#welcome");
        if (welcome) welcome.classList.add("hidden");
        $("#search-section").classList.remove("hidden");
        stopBurst();
    }

    function welcomeSearch(ticker, market) {
        if (market && market !== currentMarket) {
            currentMarket = market;
            $$(".btn-market-pill").forEach(b => b.classList.toggle("active", b.dataset.market === currentMarket));
        }
        hideWelcome();
        $("#ticker-input").value = ticker;
        doSearch();
    }


    // ── Burst Canvas Animation ──
    let burstAnim = null;
    function initBurstCanvas() {
        const canvas = $("#burst-canvas");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const rays = [];
        const RAY_COUNT = 200;
        let w, h, diag;

        function resize() {
            const rect = canvas.parentElement.getBoundingClientRect();
            w = canvas.width = rect.width;
            h = canvas.height = rect.height;
            diag = Math.sqrt(w * w + h * h) * 0.55;
        }
        resize();
        window.addEventListener("resize", resize);

        for (let i = 0; i < RAY_COUNT; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.2 + Math.random() * 0.6;
            const lenFrac = 0.4 + Math.random() * 0.6;
            rays.push({ angle, speed, lenFrac, len: Math.random(), phase: Math.random() * Math.PI * 2 });
        }

        function draw() {
            ctx.clearRect(0, 0, w, h);
            const cx = w / 2;
            const cy = h / 2;
            const time = Date.now() * 0.001;

            for (const r of rays) {
                const maxLen = diag * r.lenFrac;
                r.len += r.speed;
                if (r.len > maxLen) { r.len = 0; r.phase = Math.random() * Math.PI * 2; }

                const progress = r.len / maxLen;
                const wobble = Math.sin(time * 0.4 + r.phase) * 0.02;
                const a = r.angle + wobble;
                const x2 = cx + Math.cos(a) * r.len;
                const y2 = cy + Math.sin(a) * r.len;

                const alpha = progress < 0.05 ? progress * 20 : progress > 0.75 ? (1 - progress) * 4 : 1;
                const hue = 250 + (r.angle / (Math.PI * 2)) * 60;
                const sat = 55 + progress * 35;
                const light = 50 + progress * 25;

                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(a) * 2, cy + Math.sin(a) * 2);
                ctx.lineTo(x2, y2);
                ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${light}%, ${alpha * 0.3})`;
                ctx.lineWidth = 0.6 + progress * 0.4;
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(x2, y2, 1 + progress * 2, 0, Math.PI * 2);
                ctx.fillStyle = `hsla(${hue + 15}, ${sat + 10}%, ${light + 10}%, ${alpha * 0.55})`;
                ctx.fill();
            }

            const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, 100);
            grd.addColorStop(0, "rgba(124, 58, 237, 0.1)");
            grd.addColorStop(0.4, "rgba(88, 166, 255, 0.04)");
            grd.addColorStop(1, "transparent");
            ctx.fillStyle = grd;
            ctx.fillRect(cx - 100, cy - 100, 200, 200);

            burstAnim = requestAnimationFrame(draw);
        }
        draw();
    }

    function stopBurst() { if (burstAnim) { cancelAnimationFrame(burstAnim); burstAnim = null; } }


    // ── Init ──
    document.addEventListener("DOMContentLoaded", () => {
        loadSettings();
        loadWatchlist();
        loadPositions();
        loadTranslations().then(() => { applyLanguage(); populateSettingsUI(); });
        renderWatchlist();
        refreshWatchlistData();

        // Welcome page
        initScrollReveals();
        typewriterTick();
        initBurstCanvas();

        // Clickable feature cards
        $$(".wf-card[data-action]").forEach(card => {
            card.addEventListener("click", () => {
                const action = card.dataset.action;
                if (action === "portfolio") {
                    hideWelcome(); togglePortfolio();
                } else if (action === "compare") {
                    hideWelcome(); toggleCompare();
                } else if (action === "search") {
                    hideWelcome();
                    setTimeout(() => $("#ticker-input").focus(), 100);
                } else {
                    hideWelcome();
                    if (!currentTicker) {
                        setTimeout(() => $("#ticker-input").focus(), 100);
                    } else {
                        $$(".tab-btn").forEach(b => b.classList.remove("active"));
                        $$(".tab-content").forEach(c => c.classList.remove("active"));
                        const tabBtn = $$(`.tab-btn[data-tab="${action}"]`);
                        if (tabBtn.length) tabBtn[0].classList.add("active");
                        const tabEl = $(`#tab-${action}`);
                        if (tabEl) tabEl.classList.add("active");
                        if (action === "summary") fetchSummary();
                        if (action === "valuation") fetchValuation();
                    }
                }
            });
        });

        // Trigger cards to reveal immediately if visible
        setTimeout(() => {
            $$(".wf-card[data-reveal]").forEach((c, i) => {
                setTimeout(() => c.classList.add("revealed"), 200 + i * 100);
            });
        }, 400);



        const welcomeSearchInput = $("#welcome-search");
        if (welcomeSearchInput) {
            welcomeSearchInput.addEventListener("keydown", e => {
                if (e.key === "Enter") {
                    const val = welcomeSearchInput.value.trim();
                    if (val) welcomeSearch(val);
                }
            });
        }
        const welcomeSearchBtn = $("#welcome-search-btn");
        if (welcomeSearchBtn) {
            welcomeSearchBtn.addEventListener("click", () => {
                const val = welcomeSearchInput.value.trim();
                if (val) welcomeSearch(val);
            });
        }
        $$(".wq-chip").forEach(chip => {
            chip.addEventListener("click", () => {
                welcomeSearch(chip.dataset.ticker, chip.dataset.market);
            });
        });

        const logoBtn = $("#logo-home");
        if (logoBtn) logoBtn.addEventListener("click", showWelcome);

        $("#search-btn").addEventListener("click", () => { hideAutocomplete(); doSearch(); });
        $("#ticker-input").addEventListener("keydown", e => {
            if (handleAutocompleteNav(e)) return;
            if (e.key === "Enter") { hideAutocomplete(); doSearch(); }
        });
        $("#ticker-input").addEventListener("input", () => {
            const q = $("#ticker-input").value.trim();
            clearTimeout(acDebounce);
            if (q.length < 1) { hideAutocomplete(); return; }
            acDebounce = setTimeout(() => fetchAutocomplete(q), 250);
        });
        $("#ticker-input").addEventListener("blur", () => {
            setTimeout(hideAutocomplete, 150);
        });
        $("#watchlist-add").addEventListener("click", addToWatchlist);

        $$(".btn-market-pill").forEach(btn => btn.addEventListener("click", () => {
            $$(".btn-market-pill").forEach(b => b.classList.remove("active"));
            btn.classList.add("active"); currentMarket = btn.dataset.market;
            summaryCache = {}; valuationCache = {}; applyLanguage(); if (currentTicker) doSearch();
        }));

        $("#pb-refresh").addEventListener("click", refreshData);
        $("#pb-position-btn").addEventListener("click", openPositionForm);
        const posOv = $("#pos-overlay");
        $("#pos-close").addEventListener("click", closePositionForm);
        posOv.addEventListener("click", e => { if (e.target === posOv) closePositionForm(); });
        $("#pos-save").addEventListener("click", savePositionFromForm);
        $("#pos-remove").addEventListener("click", removePosition);
        setInterval(markTimestampStale, 60000);

        $$(".btn-period").forEach(btn => btn.addEventListener("click", () => {
            $$(".btn-period").forEach(b => b.classList.remove("active"));
            btn.classList.add("active"); currentPeriod = btn.dataset.period;
            if (currentTicker) doSearch();
        }));

        $("#lang-toggle").addEventListener("click", () => { currentLang = currentLang === "en" ? "th" : "en"; applyLanguage(); });

        $$(".btn-indicator").forEach(btn => btn.addEventListener("click", (e) => {
            if (e.target.closest(".ind-info-icon")) return;
            const k = btn.dataset.indicator;
            if (activeIndicators.has(k)) { activeIndicators.delete(k); btn.classList.remove("active"); }
            else { activeIndicators.add(k); btn.classList.add("active"); }
            updateIndicatorVisibility();
        }));
        $$(".ind-info-icon[data-edu]").forEach(icon => icon.addEventListener("click", (e) => {
            e.stopPropagation();
            showEduPopover(icon.dataset.edu);
        }));

        $$(".tab-btn").forEach(btn => btn.addEventListener("click", () => {
            $$(".tab-btn").forEach(b => b.classList.remove("active"));
            $$(".tab-content").forEach(c => c.classList.remove("active"));
            btn.classList.add("active");
            $(`#tab-${btn.dataset.tab}`).classList.add("active");
            if (btn.dataset.tab === "summary" && currentTicker) fetchSummary();
            if (btn.dataset.tab === "valuation" && currentTicker) fetchValuation();
            if (btn.dataset.tab === "backtest") { populateBtConfig(); }
        }));

        // Backtest run button
        $("#bt-run-btn").addEventListener("click", () => { if (currentTicker) fetchBacktest(); });
        ["bt-cfg-period", "bt-cfg-sensitivity"].forEach(id => {
            const el = $("#" + id);
            if (el) el.addEventListener("change", updateBtRules);
        });
        ["bt-ind-sma", "bt-ind-macd", "bt-ind-stochastic"].forEach(id => {
            const el = $("#" + id);
            if (el) el.addEventListener("change", updateBtRules);
        });
        ["bt-min-hold", "bt-cooldown", "bt-confirm"].forEach(id => {
            const el = $("#" + id);
            if (el) el.addEventListener("input", updateBtRules);
        });

        // Portfolio
        $("#portfolio-btn").addEventListener("click", togglePortfolio);
        $("#portfolio-close").addEventListener("click", closePortfolio);

        // Alerts
        $("#alerts-btn").addEventListener("click", toggleAlerts);
        $("#alerts-close").addEventListener("click", closeAlerts);
        $("#alert-create-btn").addEventListener("click", createAlertFromUI);
        $("#alert-type").addEventListener("change", () => {
            const isPrice = $("#alert-type").value === "price";
            $("#alert-price-row").style.display = isPrice ? "flex" : "none";
        });

        // Paper Trade
        $("#paper-trade-btn").addEventListener("click", togglePaperTrade);
        $("#paper-close").addEventListener("click", closePaperTrade);
        $("#paper-buy-btn").addEventListener("click", doPaperBuy);

        // Compare
        $("#compare-toggle").addEventListener("click", toggleCompare);
        $("#compare-close").addEventListener("click", toggleCompare);
        $("#compare-go").addEventListener("click", doCompare);
        $$(".compare-input").forEach(inp => inp.addEventListener("keydown", e => { if (e.key === "Enter") doCompare(); }));

        // Sidebar toggle
        $("#sidebar-toggle-btn").addEventListener("click", () => {
            $("#sidebar").classList.toggle("collapsed");
            setTimeout(handleResize, 300);
        });

        // Popover
        const helpOv = $("#popover-overlay");
        $("#signal-help-btn").addEventListener("click", () => helpOv.classList.remove("hidden"));
        $("#popover-close").addEventListener("click", () => helpOv.classList.add("hidden"));
        helpOv.addEventListener("click", e => { if (e.target === helpOv) helpOv.classList.add("hidden"); });

        // Settings
        const setOv = $("#settings-overlay");
        $("#settings-btn").addEventListener("click", () => { populateSettingsUI(); setOv.classList.remove("hidden"); });
        $("#settings-close").addEventListener("click", () => setOv.classList.add("hidden"));
        setOv.addEventListener("click", e => { if (e.target === setOv) setOv.classList.add("hidden"); });

        $$(".settings-tab").forEach(tab => tab.addEventListener("click", () => {
            $$(".settings-tab").forEach(t => t.classList.remove("active"));
            $$(".settings-tab-content").forEach(c => c.classList.remove("active"));
            tab.classList.add("active");
            $(`#stab-${tab.dataset.stab}`).classList.add("active");
        }));

        $$(".btn-sensitivity").forEach(btn => btn.addEventListener("click", () => {
            $$(".btn-sensitivity").forEach(b => b.classList.remove("active"));
            btn.classList.add("active"); settings.sensitivity = btn.dataset.sensitivity; updateSensitivityDesc();
        }));

        $("#settings-apply").addEventListener("click", () => {
            readSettingsFromUI(); saveSettings(); setOv.classList.add("hidden");
            if (currentTicker) doSearch();
        });
        $("#settings-reset").addEventListener("click", () => { settings = { ...DEFAULT_SETTINGS }; saveSettings(); populateSettingsUI(); });

        document.addEventListener("keydown", e => { if (e.key === "Escape") { helpOv.classList.add("hidden"); setOv.classList.add("hidden"); closePositionForm(); } });
        window.addEventListener("resize", handleResize);
    });

    // ── Alerts ──

    let alertsOpen = false;

    function toggleAlerts() {
        alertsOpen = !alertsOpen;
        $("#alerts-btn").classList.toggle("active", alertsOpen);
        $("#alerts-view").classList.toggle("hidden", !alertsOpen);
        if (!alertsOpen) return;
        hideWelcome();
        $("#results").classList.add("hidden");
        $("#portfolio-view").classList.add("hidden");
        $("#paper-view").classList.add("hidden");
        if (currentTicker) {
            $("#alert-ticker").value = currentTicker;
            $("#alert-market").value = currentMarket;
        }
        const savedEmail = localStorage.getItem("alertEmail");
        if (savedEmail) $("#alert-email").value = savedEmail;
        fetchAlerts();
    }

    function closeAlerts() {
        alertsOpen = false;
        $("#alerts-btn").classList.remove("active");
        $("#alerts-view").classList.add("hidden");
    }

    async function fetchAlerts() {
        try {
            const res = await fetch("/api/alerts");
            const alerts = await res.json();
            renderAlerts(alerts);
        } catch {}
    }

    function renderAlerts(alerts) {
        const container = $("#alerts-list");
        if (!alerts.length) {
            container.innerHTML = `<div class="paper-empty"><p>${t("alertsEmpty")}</p></div>`;
            return;
        }
        container.innerHTML = alerts.map(a => {
            const typeIcon = a.type === "signal" ? "📡" : "💰";
            const statusCls = a.triggered ? "triggered" : (a.active ? "active" : "inactive");
            const statusLabel = a.triggered ? "Triggered" : (a.active ? "Active" : "Inactive");
            let detail = "";
            if (a.type === "price") {
                detail = `${a.condition.direction === "above" ? "Above" : "Below"} $${a.condition.price}`;
            } else {
                detail = a.lastSignal ? `Last: ${a.lastSignal}` : "Monitoring...";
            }
            return `<div class="alert-row">
                <span class="alert-type-icon">${typeIcon}</span>
                <div class="alert-info">
                    <div class="alert-ticker-label">${a.ticker} <span class="alert-market-label">${a.market.toUpperCase()}</span></div>
                    <div class="alert-detail">${detail}</div>
                </div>
                <span class="alert-status ${statusCls}">${statusLabel}</span>
                <button class="alert-delete" data-id="${a.id}">&times;</button>
            </div>`;
        }).join("");
        container.querySelectorAll(".alert-delete").forEach(btn => {
            btn.addEventListener("click", async () => {
                await fetch(`/api/alerts/${btn.dataset.id}`, { method: "DELETE" });
                fetchAlerts();
            });
        });
    }

    async function createAlertFromUI() {
        const type = $("#alert-type").value;
        const ticker = $("#alert-ticker").value.trim();
        const market = $("#alert-market").value;
        const email = $("#alert-email").value.trim();
        const hint = $("#alert-hint");

        if (!ticker || !email) {
            hint.textContent = "Ticker and email are required.";
            hint.className = "alert-hint error";
            return;
        }
        localStorage.setItem("alertEmail", email);

        const body = { type, ticker, market, email };
        if (type === "price") {
            const price = parseFloat($("#alert-price").value);
            const direction = $("#alert-direction").value;
            if (!price || price <= 0) {
                hint.textContent = "Enter a valid target price.";
                hint.className = "alert-hint error";
                return;
            }
            body.price = price;
            body.direction = direction;
        }

        try {
            const res = await fetch("/api/alerts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                hint.textContent = "Alert created! You'll receive emails when triggered.";
                hint.className = "alert-hint success";
                fetchAlerts();
            } else {
                const d = await res.json();
                hint.textContent = d.error || "Failed to create alert.";
                hint.className = "alert-hint error";
            }
        } catch {
            hint.textContent = "Network error.";
            hint.className = "alert-hint error";
        }
    }

    // ── Paper Trading ──

    let paperOpen = false;

    function togglePaperTrade() {
        paperOpen = !paperOpen;
        $("#paper-trade-btn").classList.toggle("active", paperOpen);
        $("#paper-view").classList.toggle("hidden", !paperOpen);
        if (!paperOpen) return;
        hideWelcome();
        $("#results").classList.add("hidden");
        $("#portfolio-view").classList.add("hidden");
        $("#alerts-view").classList.add("hidden");
        if (currentTicker) {
            $("#paper-ticker").value = currentTicker;
            $("#paper-market").value = currentMarket;
        }
        fetchPaperPortfolio();
    }

    function closePaperTrade() {
        paperOpen = false;
        $("#paper-trade-btn").classList.remove("active");
        $("#paper-view").classList.add("hidden");
    }

    async function fetchPaperPortfolio() {
        try {
            const [pfRes, hRes] = await Promise.all([
                fetch("/api/paper/portfolio"),
                fetch("/api/paper/history"),
            ]);
            const portfolio = await pfRes.json();
            const history = await hRes.json();
            renderPaperPortfolio(portfolio, history);
        } catch {}
    }

    function renderPaperPortfolio(pf, hist) {
        const retCls = pf.totalReturn >= 0 ? "profit" : "loss";
        const retSign = pf.totalReturn >= 0 ? "+" : "";

        let html = `<div class="pf-summary-cards">
            <div class="pf-card">
                <div class="pf-card-label">${t("pt_cash")}</div>
                <div class="pf-card-value">$${pf.cash.toLocaleString(undefined,{minimumFractionDigits:2})}</div>
            </div>
            <div class="pf-card">
                <div class="pf-card-label">${t("pt_portfolio_value")}</div>
                <div class="pf-card-value">$${pf.portfolioValue.toLocaleString(undefined,{minimumFractionDigits:2})}</div>
            </div>
            <div class="pf-card ${retCls}">
                <div class="pf-card-label">${t("pt_total_return")}</div>
                <div class="pf-card-value">${retSign}$${pf.totalReturn.toLocaleString(undefined,{minimumFractionDigits:2})} <span class="pf-card-pct">(${retSign}${pf.totalReturnPct.toFixed(1)}%)</span></div>
            </div>
        </div>`;
        $("#paper-summary").innerHTML = html;

        if (pf.positions.length) {
            let posHtml = `<h3>${t("pt_open_positions")}</h3><div class="paper-positions-grid">`;
            for (const p of pf.positions) {
                const pCls = p.pnl >= 0 ? "profit" : "loss";
                const pSign = p.pnl >= 0 ? "+" : "";
                posHtml += `<div class="paper-pos-card">
                    <div class="paper-pos-header">
                        <span class="paper-pos-ticker">${p.ticker}</span>
                        <span class="paper-pos-shares">${p.shares} shares</span>
                    </div>
                    <div class="paper-pos-body">
                        <div class="paper-pos-row"><span>Entry</span><span>$${p.entryPrice.toFixed(2)}</span></div>
                        <div class="paper-pos-row"><span>Current</span><span>$${p.currentPrice.toFixed(2)}</span></div>
                        <div class="paper-pos-row ${pCls}"><span>P&L</span><span>${pSign}$${p.pnl.toFixed(2)} (${pSign}${p.pnlPct.toFixed(1)}%)</span></div>
                    </div>
                    <button class="btn-sell-paper" data-id="${p.id}">SELL</button>
                </div>`;
            }
            posHtml += `</div>`;
            $("#paper-positions").innerHTML = posHtml;
            $("#paper-positions").querySelectorAll(".btn-sell-paper").forEach(btn => {
                btn.addEventListener("click", async () => {
                    const res = await fetch("/api/paper/sell", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ positionId: btn.dataset.id }),
                    });
                    if (res.ok) fetchPaperPortfolio();
                });
            });
        } else {
            $("#paper-positions").innerHTML = `<div class="paper-empty"><p>${t("pt_no_positions")}</p></div>`;
        }

        if (hist.trades && hist.trades.length) {
            $("#paper-history-section").classList.remove("hidden");
            const stats = hist.stats;
            let hHtml = `<div class="paper-stats">
                <span>${stats.totalTrades} trades</span>
                <span class="profit">${stats.wins}W</span> / <span class="loss">${stats.losses}L</span>
                <span>Win rate: ${stats.winRate}%</span>
                <span class="${stats.totalPnl >= 0 ? 'profit' : 'loss'}">Total: ${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}</span>
            </div>`;
            hHtml += `<div class="paper-trades-list">`;
            for (const tr of hist.trades.slice().reverse()) {
                const cls = tr.result === "win" ? "profit" : "loss";
                const sign = tr.pnl >= 0 ? "+" : "";
                hHtml += `<div class="paper-trade-row ${cls}">
                    <span class="paper-trade-ticker">${tr.ticker}</span>
                    <span>${tr.shares} sh</span>
                    <span>$${tr.entryPrice} → $${tr.exitPrice}</span>
                    <span class="${cls}">${sign}$${tr.pnl.toFixed(2)} (${sign}${tr.pnlPct.toFixed(1)}%)</span>
                </div>`;
            }
            hHtml += `</div>`;
            $("#paper-history").innerHTML = hHtml;
        } else {
            $("#paper-history-section").classList.add("hidden");
        }
    }

    async function doPaperBuy() {
        const ticker = $("#paper-ticker").value.trim();
        const market = $("#paper-market").value;
        const shares = parseInt($("#paper-shares").value);
        const hint = $("#paper-hint");

        if (!ticker || !shares || shares <= 0) {
            hint.textContent = "Enter a ticker and positive number of shares.";
            hint.className = "alert-hint error";
            return;
        }
        try {
            const res = await fetch("/api/paper/buy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ticker, market, shares }),
            });
            const data = await res.json();
            if (data.error) {
                hint.textContent = data.error;
                hint.className = "alert-hint error";
            } else {
                hint.textContent = `Bought ${shares} shares of ${ticker.toUpperCase()}!`;
                hint.className = "alert-hint success";
                $("#paper-shares").value = "";
                fetchPaperPortfolio();
            }
        } catch {
            hint.textContent = "Network error.";
            hint.className = "alert-hint error";
        }
    }

})();
