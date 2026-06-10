(() => {
    "use strict";

    let currentLang = "en";
    let currentPeriod = "6mo";
    let currentInterval = "1d";
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

    let priceChart, macdChart, stochChart, rsiChart;
    let priceCandleSeries = null;
    let lastUpdatedTime = null;
    let lastIndicatorData = null;
    let lastCandlesData = null;
    let lastCrossovers = null;
    let syncingCrosshair = false;

    // Line-style label helper, keyed to Lightweight Charts' numeric enum.
    const LINE_STYLE_OPTIONS = [
        { value: 0, label: "Solid" },
        { value: 1, label: "Dotted" },
        { value: 2, label: "Dashed" },
        { value: 3, label: "Large dashed" },
        { value: 4, label: "Sparse dotted" },
    ];

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
        emaPeriods: [9, 21, 50, 200],
        bbPeriod: 20, bbStd: 2.0,
        rsiPeriod: 14, rsiOb: 70, rsiOs: 30,
        vwapPeriod: 20,
    };
    let settings = { ...DEFAULT_SETTINGS };

    function loadSettings() {
        try {
            const s = localStorage.getItem("setTradeSettings");
            if (s) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) };
            if (!Array.isArray(settings.emaPeriods) || !settings.emaPeriods.length) {
                settings.emaPeriods = [...DEFAULT_SETTINGS.emaPeriods];
            }
        } catch {}
    }
    function saveSettings() { localStorage.setItem("setTradeSettings", JSON.stringify(settings)); }

    function settingsToQuery() {
        const ema = (settings.emaPeriods || []).join(",");
        return `&sma_short=${settings.smaShort}&sma_long=${settings.smaLong}` +
            `&macd_fast=${settings.macdFast}&macd_slow=${settings.macdSlow}&macd_signal=${settings.macdSignal}` +
            `&stoch_k=${settings.stochK}&stoch_smooth=${settings.stochSmooth}` +
            `&stoch_ob=${settings.stochOb}&stoch_os=${settings.stochOs}` +
            `&ema_periods=${encodeURIComponent(ema)}` +
            `&bb_period=${settings.bbPeriod}&bb_std=${settings.bbStd}` +
            `&rsi_period=${settings.rsiPeriod}` +
            `&vwap_period=${settings.vwapPeriod}`;
    }

    // ── Chart Studies (TradingView-style overlays/panes state) ──
    //
    // lineStyle in Lightweight Charts:
    //   0 = solid, 1 = dotted, 2 = dashed, 3 = large dashed, 4 = sparse dotted
    //
    // EMA toggles/styles are keyed by *slot index* (0..3), not by period,
    // so user customizations survive period changes.

    const DEFAULT_STUDIES = {
        chartType: "candles",   // candles | line | area | bars | heikin
        log: false,
        volume: true,
        ema: { 0: true, 1: true, 2: false, 3: false },
        sma: true,
        bb: false,
        vwap: false,
        rsi: true,
        style: {
            ema: [
                { color: "#06d6a0", width: 2, lineStyle: 0 },
                { color: "#58a6ff", width: 2, lineStyle: 0 },
                { color: "#d29922", width: 2, lineStyle: 0 },
                { color: "#a371f7", width: 2, lineStyle: 0 },
            ],
            sma: {
                short: { color: "#58a6ff", width: 2, lineStyle: 0 },
                long:  { color: "#d29922", width: 2, lineStyle: 0 },
            },
            bb: {
                upper:  { color: "#7c3aed", width: 1, lineStyle: 0 },
                middle: { color: "#7c3aed", width: 1, lineStyle: 2 },
                lower:  { color: "#7c3aed", width: 1, lineStyle: 0 },
            },
            vwap: { color: "#f0b429", width: 2, lineStyle: 0 },
            rsi:  { color: "#58a6ff", width: 2, lineStyle: 0 },
            macd: {
                line:    { color: "#58a6ff", width: 2, lineStyle: 0 },
                signal:  { color: "#f78166", width: 2, lineStyle: 0 },
                upHist:   "#3fb950",
                downHist: "#f85149",
            },
            stoch: {
                k:  { color: "#58a6ff", width: 2, lineStyle: 0 },
                d:  { color: "#f78166", width: 2, lineStyle: 0 },
                ob: "#f85149",
                os: "#3fb950",
            },
        },
    };
    let studies = JSON.parse(JSON.stringify(DEFAULT_STUDIES));

    function deepMerge(target, source) {
        if (!source || typeof source !== "object") return target;
        for (const k of Object.keys(source)) {
            const sv = source[k];
            if (sv && typeof sv === "object" && !Array.isArray(sv) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) {
                target[k] = deepMerge({ ...target[k] }, sv);
            } else {
                target[k] = sv;
            }
        }
        return target;
    }

    function loadStudies() {
        try {
            const raw = localStorage.getItem("setTradeStudies");
            if (!raw) return;
            const parsed = JSON.parse(raw);

            // Migrate legacy period-keyed EMA state (e.g. {9: true}) to slot keys.
            if (parsed.ema && Object.keys(parsed.ema).some(k => parseInt(k, 10) > 4)) {
                const migrated = {};
                const defaults = settings.emaPeriods || [9, 21, 50, 200];
                defaults.forEach((p, idx) => {
                    if (parsed.ema[p] != null) migrated[idx] = !!parsed.ema[p];
                });
                parsed.ema = migrated;
            }

            studies = deepMerge(JSON.parse(JSON.stringify(DEFAULT_STUDIES)), parsed);

            // Make sure style.ema is always 4 slots long.
            if (!Array.isArray(studies.style.ema)) {
                studies.style.ema = JSON.parse(JSON.stringify(DEFAULT_STUDIES.style.ema));
            }
            while (studies.style.ema.length < 4) {
                studies.style.ema.push(JSON.parse(JSON.stringify(DEFAULT_STUDIES.style.ema[studies.style.ema.length])));
            }
        } catch {}
    }
    function saveStudies() { localStorage.setItem("setTradeStudies", JSON.stringify(studies)); }

    function isEmaOn(slot) { return !!(studies.ema && studies.ema[slot]); }
    function toggleEma(slot) {
        studies.ema = studies.ema || {};
        studies.ema[slot] = !studies.ema[slot];
        saveStudies();
    }

    // Style accessor — `path` is a dot path like "ema.0", "bb.upper", "vwap", "rsi", "sma.short".
    function styleAt(path) {
        const parts = path.split(".");
        let cur = studies.style;
        for (const p of parts) {
            if (cur == null) return null;
            cur = cur[p];
        }
        return cur;
    }
    function setStyle(path, patch) {
        const parts = path.split(".");
        let cur = studies.style;
        for (let i = 0; i < parts.length - 1; i++) {
            cur = cur[parts[i]];
            if (cur == null) return;
        }
        const last = parts[parts.length - 1];
        cur[last] = { ...cur[last], ...patch };
        saveStudies();
    }

    function applyStudyButtonStates() {
        document.querySelectorAll("#studies-bar [data-group='chartType'] .study-pill").forEach(b => {
            b.classList.toggle("active", b.dataset.type === studies.chartType);
        });
        document.querySelectorAll("#studies-bar [data-study='ema']").forEach(b => {
            const slot = parseInt(b.dataset.slot, 10);
            b.classList.toggle("active", isEmaOn(slot));
        });
        const setPill = (key, on) => {
            const el = document.querySelector(`#studies-bar [data-study='${key}']`);
            if (el) el.classList.toggle("active", !!on);
        };
        setPill("bb", studies.bb);
        setPill("vwap", studies.vwap);
        setPill("volume", studies.volume);
        setPill("rsi", studies.rsi);
        const logCb = document.getElementById("study-log");
        if (logCb) logCb.checked = !!studies.log;
        const rsiCont = document.getElementById("rsi-chart-container");
        if (rsiCont) rsiCont.classList.toggle("hidden", !studies.rsi);
        // Sync the colored dots in the studies bar (BB / VWAP / EMA chips).
        paintStudyDots();
    }

    function paintStudyDots() {
        // EMA dots come from studies.style.ema[slot]
        document.querySelectorAll("#studies-bar [data-study='ema'] .study-dot").forEach(dot => {
            const slot = parseInt(dot.parentElement.dataset.slot, 10);
            const st = styleAt(`ema.${slot}`);
            if (st) dot.style.background = st.color;
        });
        const setDot = (sel, color) => {
            const dot = document.querySelector(`#studies-bar [data-study='${sel}'] .study-dot`);
            if (dot && color) dot.style.background = color;
        };
        setDot("bb", styleAt("bb.upper")?.color);
        setDot("vwap", styleAt("vwap")?.color);
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
        if ($("#bb-period")) $("#bb-period").value = settings.bbPeriod;
        if ($("#bb-std")) $("#bb-std").value = settings.bbStd;
        if ($("#rsi-period")) $("#rsi-period").value = settings.rsiPeriod;
        if ($("#rsi-ob")) $("#rsi-ob").value = settings.rsiOb;
        if ($("#rsi-os")) $("#rsi-os").value = settings.rsiOs;
        if ($("#vwap-period")) $("#vwap-period").value = settings.vwapPeriod;
        $$(".btn-sensitivity").forEach(b => b.classList.toggle("active", b.dataset.sensitivity === settings.sensitivity));
        updateSensitivityDesc();
        // Build dynamic style controls (EMA period inputs live here, so this also
        // ensures #ema-1..#ema-4 exist before readSettingsFromUI() runs).
        populateStyleControls();
        updateIndicatorSummaries();
    }

    function updateIndicatorSummaries() {
        const s = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
        s("#sma-summary", `${settings.smaShort} / ${settings.smaLong}`);
        s("#macd-summary", `${settings.macdFast} / ${settings.macdSlow} / ${settings.macdSignal}`);
        s("#stoch-summary", `${settings.stochK} / ${settings.stochSmooth} · ${settings.stochOb}/${settings.stochOs}`);
        s("#ema-summary", (settings.emaPeriods || []).join(" / "));
        s("#bb-summary", `${settings.bbPeriod} / ${Number(settings.bbStd).toFixed(1)}`);
        s("#rsi-summary", `${settings.rsiPeriod} · ${settings.rsiOb}/${settings.rsiOs}`);
        s("#vwap-summary", `${settings.vwapPeriod}`);
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
        const emaIn = [];
        for (let i = 0; i < 4; i++) {
            const el = $(`#ema-${i + 1}`);
            if (!el) continue;
            const v = parseInt(el.value, 10);
            if (Number.isFinite(v) && v > 1 && v <= 500) emaIn.push(v);
        }
        if (emaIn.length) settings.emaPeriods = emaIn;
        if ($("#bb-period")) settings.bbPeriod = parseInt($("#bb-period").value) || 20;
        if ($("#bb-std")) settings.bbStd = parseFloat($("#bb-std").value) || 2.0;
        if ($("#rsi-period")) settings.rsiPeriod = parseInt($("#rsi-period").value) || 14;
        if ($("#rsi-ob")) settings.rsiOb = parseInt($("#rsi-ob").value) || 70;
        if ($("#rsi-os")) settings.rsiOs = parseInt($("#rsi-os").value) || 30;
        if ($("#vwap-period")) settings.vwapPeriod = parseInt($("#vwap-period").value) || 20;
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

    function isIntradayInterval(iv) {
        return ["1m", "2m", "5m", "15m", "30m", "60m", "1h", "90m"].includes(iv);
    }

    function makeChart(container, h, opts = {}) {
        const intraday = isIntradayInterval(currentInterval);
        return LightweightCharts.createChart(container, {
            width: container.clientWidth, height: h,
            layout: { background: { type: "solid", color: cc.background }, textColor: cc.textColor, fontFamily: "Inter, sans-serif" },
            grid: { vertLines: { color: cc.gridColor }, horzLines: { color: cc.gridColor } },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: {
                borderColor: cc.gridColor,
                mode: opts.log ? LightweightCharts.PriceScaleMode.Logarithmic : LightweightCharts.PriceScaleMode.Normal,
            },
            timeScale: {
                borderColor: cc.gridColor,
                timeVisible: intraday,
                secondsVisible: false,
                rightOffset: 6,
            },
        });
    }

    function syncCharts() {
        const charts = [priceChart, macdChart, stochChart, rsiChart].filter(Boolean);
        if (charts.length < 2) return;
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

    function paramTimeToKey(time) {
        if (time == null) return null;
        if (typeof time === "object") {
            return `${time.year}-${String(time.month).padStart(2,"0")}-${String(time.day).padStart(2,"0")}`;
        }
        return time; // string or unix-seconds number — used directly for findByTime
    }

    function updateReadout(timeKey) {
        const el = $("#price-readout");
        if (!el || !lastCandlesData) return;
        let candle = null;
        if (timeKey == null) {
            candle = lastCandlesData[lastCandlesData.length - 1];
        } else {
            // Match either exact (intraday epoch second) or date prefix (daily YYYY-MM-DD).
            for (const c of lastCandlesData) {
                if (c.time === timeKey) { candle = c; break; }
                if (typeof c.time === "string" && c.time === timeKey) { candle = c; break; }
            }
        }
        if (!candle) { el.classList.remove("visible"); return; }
        const change = candle.close - candle.open;
        const pct = candle.open ? (change / candle.open) * 100 : 0;
        const cls = change >= 0 ? "up" : "down";
        const sign = change >= 0 ? "+" : "";
        const timeLabel = (typeof candle.time === "number")
            ? new Date(candle.time * 1000).toISOString().slice(0, 16).replace("T", " ")
            : candle.time;
        const volTxt = candle.volume >= 1e6
            ? (candle.volume / 1e6).toFixed(2) + "M"
            : candle.volume >= 1e3 ? (candle.volume / 1e3).toFixed(1) + "K"
            : String(candle.volume);
        el.innerHTML =
            `<span class="ro-time">${timeLabel}</span>` +
            `<span><span class="ro-tag">O</span><span class="ro-val">${candle.open.toFixed(2)}</span></span>` +
            `<span><span class="ro-tag">H</span><span class="ro-val">${candle.high.toFixed(2)}</span></span>` +
            `<span><span class="ro-tag">L</span><span class="ro-val">${candle.low.toFixed(2)}</span></span>` +
            `<span><span class="ro-tag">C</span><span class="ro-val ${cls}">${candle.close.toFixed(2)}</span></span>` +
            `<span><span class="ro-tag">Δ</span><span class="ro-val ${cls}">${sign}${change.toFixed(2)} (${sign}${pct.toFixed(2)}%)</span></span>` +
            `<span><span class="ro-tag">V</span><span class="ro-val">${volTxt}</span></span>`;
        el.classList.add("visible");
    }

    function updateChartLegends(param) {
        if (!lastIndicatorData) return;
        const ind = lastIndicatorData;
        const priceLeg = $("#price-chart-legend");
        const macdLeg = $("#macd-chart-legend");
        const stochLeg = $("#stoch-chart-legend");
        const rsiLeg = $("#rsi-chart-legend");

        const timeKey = paramTimeToKey(param && param.time);

        if (timeKey == null) {
            if (priceLeg) updatePriceLegend(priceLeg, ind, -1);
            if (macdLeg) updateMacdLegend(macdLeg, ind, -1);
            if (stochLeg) updateStochLegend(stochLeg, ind, -1);
            if (rsiLeg) updateRsiLegend(rsiLeg, ind, -1);
            updateReadout(null);
            return;
        }

        if (priceLeg) updatePriceLegend(priceLeg, ind, timeKey);
        if (macdLeg) updateMacdLegend(macdLeg, ind, timeKey);
        if (stochLeg) updateStochLegend(stochLeg, ind, timeKey);
        if (rsiLeg) updateRsiLegend(rsiLeg, ind, timeKey);
        updateReadout(timeKey);
    }

    function findByTime(arr, t) {
        if (!arr || !arr.length) return null;
        if (t === -1) return arr[arr.length - 1];
        return arr.find(d => d.time === t) || null;
    }

    function legendChip(color, label, value, digits = 2) {
        const dot = color ? `<span class="cl-dot" style="background:${color}"></span>` : "";
        return `<span class="cl-item">${dot}${label}: <span class="cl-val">${Number(value).toFixed(digits)}</span></span>`;
    }

    function updatePriceLegend(el, ind, t) {
        let h = "";
        const ss = findByTime(ind.sma_short, t);
        const sl = findByTime(ind.sma_long, t);
        if (studies.sma && ss) h += legendChip(styleAt("sma.short").color, `SMA ${settings.smaShort}`, ss.value);
        if (studies.sma && sl) h += legendChip(styleAt("sma.long").color,  `SMA ${settings.smaLong}`,  sl.value);

        if (ind.ema && ind.ema.series) {
            const periods = ind.ema.periods || [];
            periods.forEach((p, idx) => {
                if (!isEmaOn(idx)) return;
                const point = findByTime(ind.ema.series[String(p)], t);
                if (point) h += legendChip(styleAt(`ema.${idx}`).color, `EMA ${p}`, point.value);
            });
        }

        if (studies.bb && ind.bb) {
            const up = findByTime(ind.bb.upper, t);
            const mid = findByTime(ind.bb.middle, t);
            const lo = findByTime(ind.bb.lower, t);
            if (up && mid && lo) {
                const c = styleAt("bb.upper").color;
                h += `<span class="cl-item"><span class="cl-dot" style="background:${c}"></span>BB(${ind.bb.period},${ind.bb.std}): <span class="cl-val">${lo.value.toFixed(2)} / ${mid.value.toFixed(2)} / ${up.value.toFixed(2)}</span></span>`;
            }
        }
        if (studies.vwap && ind.vwap) {
            const v = findByTime(ind.vwap.series, t);
            if (v) h += legendChip(styleAt("vwap").color, `VWAP ${ind.vwap.period}`, v.value);
        }

        el.innerHTML = h;
    }

    function updateMacdLegend(el, ind, t) {
        const d = findByTime(ind.macd, t);
        if (!d) { el.innerHTML = ""; return; }
        const sl = styleAt("macd.line").color, ss = styleAt("macd.signal").color;
        el.innerHTML =
            `<span class="cl-item"><span class="cl-dot" style="background:${sl}"></span>MACD: <span class="cl-val">${d.macd.toFixed(4)}</span></span>` +
            `<span class="cl-item"><span class="cl-dot" style="background:${ss}"></span>Signal: <span class="cl-val">${d.signal.toFixed(4)}</span></span>` +
            `<span class="cl-item">Hist: <span class="cl-val" style="color:${d.histogram >= 0 ? "var(--green)" : "var(--red)"}">${d.histogram >= 0 ? "+" : ""}${d.histogram.toFixed(4)}</span></span>`;
    }

    function updateStochLegend(el, ind, t) {
        const d = findByTime(ind.stochastic, t);
        if (!d) { el.innerHTML = ""; return; }
        const kc = styleAt("stoch.k").color, dc = styleAt("stoch.d").color;
        el.innerHTML =
            `<span class="cl-item"><span class="cl-dot" style="background:${kc}"></span>%K: <span class="cl-val">${d.k.toFixed(1)}</span></span>` +
            `<span class="cl-item"><span class="cl-dot" style="background:${dc}"></span>%D: <span class="cl-val">${d.d.toFixed(1)}</span></span>`;
    }

    function updateRsiLegend(el, ind, t) {
        if (!ind.rsi || !ind.rsi.series) { el.innerHTML = ""; return; }
        const d = findByTime(ind.rsi.series, t);
        if (!d) { el.innerHTML = ""; return; }
        const v = d.value;
        const cls = v >= settings.rsiOb ? "var(--red)" : v <= settings.rsiOs ? "var(--green)" : "var(--text-primary)";
        const c = styleAt("rsi").color;
        el.innerHTML =
            `<span class="cl-item"><span class="cl-dot" style="background:${c}"></span>RSI ${ind.rsi.period}: <span class="cl-val" style="color:${cls}">${v.toFixed(2)}</span></span>` +
            `<span class="cl-item" style="color:var(--text-secondary)">OB ${settings.rsiOb} · OS ${settings.rsiOs}</span>`;
    }

    function candlesToLine(candles) {
        return candles.map(d => ({ time: d.time, value: d.close }));
    }

    // Heikin Ashi transform. Returns a new candles array with smoothed OHLC.
    // Volume is kept verbatim from the original series.
    function toHeikinAshi(candles) {
        const out = [];
        let prev = null;
        for (const c of candles) {
            const haClose = (c.open + c.high + c.low + c.close) / 4;
            const haOpen = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
            const haHigh = Math.max(c.high, haOpen, haClose);
            const haLow = Math.min(c.low, haOpen, haClose);
            const ha = {
                time: c.time,
                open: +haOpen.toFixed(4),
                high: +haHigh.toFixed(4),
                low: +haLow.toFixed(4),
                close: +haClose.toFixed(4),
                volume: c.volume,
            };
            out.push(ha);
            prev = ha;
        }
        return out;
    }

    function renderPriceChart(candles, ind, crossovers) {
        const c = $("#price-chart"); c.innerHTML = "";
        priceChart = makeChart(c, 420, { log: !!studies.log });

        // Volume histogram (toggleable).
        if (studies.volume) {
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
        }

        // Primary price series — type-driven.
        let mainSeries;
        const type = studies.chartType || "candles";
        if (type === "line") {
            mainSeries = priceChart.addLineSeries({
                color: "#58a6ff", lineWidth: 2, lastValueVisible: true, priceLineVisible: true,
            });
            mainSeries.setData(candlesToLine(candles));
        } else if (type === "area") {
            mainSeries = priceChart.addAreaSeries({
                lineColor: "#58a6ff", topColor: "rgba(88,166,255,0.35)", bottomColor: "rgba(88,166,255,0.02)",
                lineWidth: 2, lastValueVisible: true, priceLineVisible: true,
            });
            mainSeries.setData(candlesToLine(candles));
        } else if (type === "bars") {
            mainSeries = priceChart.addBarSeries({
                upColor: "#3fb950", downColor: "#f85149", thinBars: true,
            });
            mainSeries.setData(candles);
        } else if (type === "heikin") {
            mainSeries = priceChart.addCandlestickSeries({
                upColor: "#3fb950", downColor: "#f85149",
                borderUpColor: "#3fb950", borderDownColor: "#f85149",
                wickUpColor: "#3fb950", wickDownColor: "#f85149",
            });
            mainSeries.setData(toHeikinAshi(candles));
        } else {
            mainSeries = priceChart.addCandlestickSeries({
                upColor: "#3fb950", downColor: "#f85149",
                borderUpColor: "#3fb950", borderDownColor: "#f85149",
                wickUpColor: "#3fb950", wickDownColor: "#f85149",
            });
            mainSeries.setData(candles);
        }
        priceCandleSeries = mainSeries;

        const lineOpts = (st, extra = {}) => ({
            color: st.color,
            lineWidth: st.width,
            lineStyle: st.lineStyle,
            lastValueVisible: false,
            priceLineVisible: false,
            ...extra,
        });

        // SMA overlays (kept tied to existing settings).
        if (studies.sma) {
            if (ind.sma_short && ind.sma_short.length) {
                const s = priceChart.addLineSeries(lineOpts(styleAt("sma.short")));
                s.setData(ind.sma_short);
            }
            if (ind.sma_long && ind.sma_long.length) {
                const s = priceChart.addLineSeries(lineOpts(styleAt("sma.long")));
                s.setData(ind.sma_long);
            }
        }

        // EMA overlays — keyed by slot, not by period.
        if (ind.ema && ind.ema.series) {
            (ind.ema.periods || []).forEach((p, idx) => {
                if (!isEmaOn(idx)) return;
                const data = ind.ema.series[String(p)];
                if (!data || !data.length) return;
                const st = styleAt(`ema.${idx}`);
                if (!st) return;
                const s = priceChart.addLineSeries(lineOpts(st));
                s.setData(data);
            });
        }

        // Bollinger Bands.
        if (studies.bb && ind.bb && ind.bb.upper && ind.bb.upper.length) {
            const up = priceChart.addLineSeries(lineOpts(styleAt("bb.upper")));
            up.setData(ind.bb.upper);
            const mid = priceChart.addLineSeries(lineOpts(styleAt("bb.middle")));
            mid.setData(ind.bb.middle);
            const lo = priceChart.addLineSeries(lineOpts(styleAt("bb.lower")));
            lo.setData(ind.bb.lower);
        }

        // VWAP.
        if (studies.vwap && ind.vwap && ind.vwap.series && ind.vwap.series.length) {
            const v = priceChart.addLineSeries(lineOpts(styleAt("vwap")));
            v.setData(ind.vwap.series);
        }

        // Markers (only useful on candle/bar series).
        if (crossovers && crossovers.length && (type === "candles" || type === "bars")) {
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
            if (markers.length) mainSeries.setMarkers(markers);
        }

        priceChart.timeScale().fitContent();
    }

    function withAlpha(hex, alpha) {
        const m = /^#?([a-f0-9]{6})$/i.exec(hex || "");
        if (!m) return hex;
        const n = parseInt(m[1], 16);
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return `rgba(${r},${g},${b},${alpha})`;
    }

    function renderMacdChart(data) {
        const c = $("#macd-chart"); c.innerHTML = "";
        macdChart = makeChart(c, 180);
        const macdStyle = studies.style.macd;
        const upHist = macdStyle.upHist || "#3fb950";
        const dnHist = macdStyle.downHist || "#f85149";
        const hist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        hist.setData(data.map(d => ({
            time: d.time,
            value: d.histogram,
            color: d.histogram >= 0 ? withAlpha(upHist, 0.6) : withAlpha(dnHist, 0.6),
        })));
        const ml = macdChart.addLineSeries({
            color: macdStyle.line.color, lineWidth: macdStyle.line.width, lineStyle: macdStyle.line.lineStyle,
            lastValueVisible: false, priceLineVisible: false,
        });
        ml.setData(data.map(d => ({ time: d.time, value: d.macd })));
        const sl = macdChart.addLineSeries({
            color: macdStyle.signal.color, lineWidth: macdStyle.signal.width, lineStyle: macdStyle.signal.lineStyle,
            lastValueVisible: false, priceLineVisible: false,
        });
        sl.setData(data.map(d => ({ time: d.time, value: d.signal })));
        macdChart.timeScale().fitContent();
    }

    function renderStochChart(data) {
        const c = $("#stoch-chart"); c.innerHTML = "";
        stochChart = makeChart(c, 180);
        const stStyle = studies.style.stoch;
        const kl = stochChart.addLineSeries({
            color: stStyle.k.color, lineWidth: stStyle.k.width, lineStyle: stStyle.k.lineStyle,
            lastValueVisible: false, priceLineVisible: false,
        });
        kl.setData(data.map(d => ({ time: d.time, value: d.k })));
        const dl = stochChart.addLineSeries({
            color: stStyle.d.color, lineWidth: stStyle.d.width, lineStyle: stStyle.d.lineStyle,
            lastValueVisible: false, priceLineVisible: false,
        });
        dl.setData(data.map(d => ({ time: d.time, value: d.d })));
        if (data.length) {
            const times = data.map(d => d.time);
            const ob = stochChart.addLineSeries({ color: withAlpha(stStyle.ob || "#f85149", 0.3), lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
            const os = stochChart.addLineSeries({ color: withAlpha(stStyle.os || "#3fb950", 0.3), lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
            ob.setData(times.map(time => ({ time, value: settings.stochOb })));
            os.setData(times.map(time => ({ time, value: settings.stochOs })));
        }
        stochChart.timeScale().fitContent();
    }

    function renderRsiChart(rsi) {
        const cont = $("#rsi-chart-container");
        if (!studies.rsi) {
            if (cont) cont.classList.add("hidden");
            rsiChart = null;
            return;
        }
        if (cont) cont.classList.remove("hidden");
        const c = $("#rsi-chart");
        if (!c || !rsi || !rsi.series || !rsi.series.length) {
            rsiChart = null;
            return;
        }
        c.innerHTML = "";
        rsiChart = makeChart(c, 160);
        const st = styleAt("rsi");
        const line = rsiChart.addLineSeries({
            color: st.color, lineWidth: st.width, lineStyle: st.lineStyle,
            lastValueVisible: false, priceLineVisible: false,
        });
        line.setData(rsi.series);
        const times = rsi.series.map(d => d.time);
        const ob = rsiChart.addLineSeries({ color: "rgba(248,81,73,0.4)", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
        const mid = rsiChart.addLineSeries({ color: "rgba(139,148,158,0.35)", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
        const os = rsiChart.addLineSeries({ color: "rgba(63,185,80,0.4)", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
        ob.setData(times.map(time => ({ time, value: settings.rsiOb })));
        mid.setData(times.map(time => ({ time, value: 50 })));
        os.setData(times.map(time => ({ time, value: settings.rsiOs })));
        rsiChart.priceScale("right").applyOptions({ autoScale: false });
        try { rsiChart.priceScale("right").setVisibleRange?.({ from: 0, to: 100 }); } catch {}
        rsiChart.timeScale().fitContent();
    }

    // Re-render everything from cached data (no network call).
    function renderAllCharts() {
        if (!lastCandlesData || !lastIndicatorData) return;
        renderPriceChart(lastCandlesData, lastIndicatorData, lastCrossovers);
        renderMacdChart(lastIndicatorData.macd);
        renderStochChart(lastIndicatorData.stochastic);
        renderRsiChart(lastIndicatorData.rsi);
        syncCharts();
        updateChartLegends({ time: null });
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
            const url = `/api/stock/${encodeURIComponent(ticker)}?period=${currentPeriod}&interval=${currentInterval}&market=${currentMarket}${settingsToQuery()}`;
            const res = await fetchWithTimeout(url, { signal: searchAbort.signal }, 20000);
            if (mySeq !== searchSeq) return;
            if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t("fetchError")); }
            const data = await res.json();
            if (mySeq !== searchSeq) return;
            $("#stock-name").textContent = data.name;
            $("#stock-ticker").textContent = data.ticker;
            $("#results").classList.remove("hidden");
            lastIndicatorData = data.indicators;
            lastCandlesData = data.candles;
            lastCrossovers = data.signal.crossovers;
            renderPriceChart(data.candles, data.indicators, data.signal.crossovers);
            renderMacdChart(data.indicators.macd);
            renderStochChart(data.indicators.stochastic);
            renderRsiChart(data.indicators.rsi);
            syncCharts();
            updateChartLegends({ time: null });
            applyStudyButtonStates();
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
        if (rsiChart && $("#rsi-chart")) rsiChart.applyOptions({ width: $("#rsi-chart").clientWidth });
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
    // Map an intraday interval to the largest period yfinance will let us pull.
    // Returns null when any period is fine (daily / weekly).
    function intervalPeriodCap(iv) {
        switch (iv) {
            case "1m":
            case "2m":  return "5d";
            case "5m":
            case "15m":
            case "30m":
            case "90m": return "1mo";
            case "60m":
            case "1h":  return "6mo";
            default:    return null;
        }
    }

    const PERIOD_RANK = { "1mo": 0, "3mo": 1, "6mo": 2, "1y": 3, "2y": 4, "5y": 5 };

    function applyIntervalConstraints() {
        const cap = intervalPeriodCap(currentInterval);
        const allBtns = document.querySelectorAll(".btn-period");
        if (!cap) {
            allBtns.forEach(b => b.classList.remove("disabled"));
            return;
        }
        // Disable period buttons that exceed the cap, and clamp currentPeriod.
        const capRank = PERIOD_RANK[cap];
        allBtns.forEach(b => {
            const r = PERIOD_RANK[b.dataset.period];
            const overCap = r != null && capRank != null && r > capRank;
            b.classList.toggle("disabled", overCap);
        });
        if (PERIOD_RANK[currentPeriod] > capRank) {
            currentPeriod = cap;
            allBtns.forEach(b => b.classList.toggle("active", b.dataset.period === cap));
        }
    }

    // ── Settings-panel style controls ──

    function styleOptsHtml(current) {
        return LINE_STYLE_OPTIONS.map(o =>
            `<option value="${o.value}" ${o.value === (current || 0) ? "selected" : ""}>${o.label}</option>`
        ).join("");
    }

    // Render a single style row (color / width / line style) bound to a style path.
    function buildStyleRow(label, path, opts = {}) {
        const st = styleAt(path) || { color: "#58a6ff", width: 2, lineStyle: 0 };
        const periodCell = opts.periodInputId
            ? `<input type="number" class="sr-period" id="${opts.periodInputId}" value="${opts.periodValue ?? ""}" min="2" max="500" step="1">`
            : `<span></span>`;
        const widthControl = opts.colorOnly
            ? `<span></span><span></span>`
            : `<input type="range" min="1" max="4" step="1" value="${st.width || 2}" data-bind="width"><span class="sr-width-val">${st.width || 2}px</span>`;
        const styleControl = opts.colorOnly
            ? `<span></span>`
            : `<select class="sr-style" data-bind="lineStyle">${styleOptsHtml(st.lineStyle)}</select>`;
        return `<div class="style-row" data-style-path="${path}">
            <label>${label}</label>
            ${periodCell}
            <input type="color" value="${st.color}" data-bind="color">
            ${widthControl}
            ${styleControl}
        </div>`;
    }

    function bindStyleRow(row) {
        const path = row.dataset.stylePath;
        if (!path) return;
        row.querySelectorAll("[data-bind]").forEach(input => {
            const key = input.dataset.bind;
            const handler = () => {
                let value;
                if (key === "color") value = input.value;
                else if (key === "width") {
                    value = parseInt(input.value, 10);
                    const out = row.querySelector(".sr-width-val");
                    if (out) out.textContent = `${value}px`;
                } else if (key === "lineStyle") value = parseInt(input.value, 10);
                setStyle(path, { [key]: value });
                applyStudyButtonStates();
                renderAllCharts();
            };
            input.addEventListener("input", handler);
            input.addEventListener("change", handler);
        });
    }

    function populateStyleControls() {
        const ema = settings.emaPeriods || [];
        const emaBody = document.getElementById("ema-style-body");
        if (emaBody) {
            emaBody.innerHTML = [0, 1, 2, 3].map(slot =>
                buildStyleRow(`EMA ${slot + 1}`, `ema.${slot}`, {
                    periodInputId: `ema-${slot + 1}`,
                    periodValue: ema[slot] || "",
                })
            ).join("");
            emaBody.querySelectorAll(".style-row").forEach(bindStyleRow);
            // Period inputs are read via readSettingsFromUI on Apply, not bound to style.
        }

        const smaBody = document.getElementById("sma-style-body");
        if (smaBody) {
            smaBody.innerHTML =
                buildStyleRow(`SMA ${settings.smaShort}`, "sma.short") +
                buildStyleRow(`SMA ${settings.smaLong}`,  "sma.long");
            smaBody.querySelectorAll(".style-row").forEach(bindStyleRow);
        }

        const bbBody = document.getElementById("bb-style-body");
        if (bbBody) {
            bbBody.innerHTML =
                buildStyleRow("Upper",  "bb.upper") +
                buildStyleRow("Middle", "bb.middle") +
                buildStyleRow("Lower",  "bb.lower");
            bbBody.querySelectorAll(".style-row").forEach(bindStyleRow);
        }

        const vwapBody = document.getElementById("vwap-style-body");
        if (vwapBody) {
            vwapBody.innerHTML = buildStyleRow("Line", "vwap");
            vwapBody.querySelectorAll(".style-row").forEach(bindStyleRow);
        }

        const rsiBody = document.getElementById("rsi-style-body");
        if (rsiBody) {
            rsiBody.innerHTML = buildStyleRow("Line", "rsi");
            rsiBody.querySelectorAll(".style-row").forEach(bindStyleRow);
        }

        const macdBody = document.getElementById("macd-style-body");
        if (macdBody) {
            macdBody.innerHTML =
                buildStyleRow("MACD",    "macd.line") +
                buildStyleRow("Signal",  "macd.signal") +
                `<div class="style-row" data-extra="macd-hist">
                    <label>Histogram</label>
                    <span></span>
                    <input type="color" id="macd-up-color" value="${studies.style.macd.upHist}">
                    <span style="font-size:0.72rem;color:var(--text-secondary);">up</span>
                    <input type="color" id="macd-down-color" value="${studies.style.macd.downHist}">
                    <span style="font-size:0.72rem;color:var(--text-secondary);">down</span>
                </div>`;
            macdBody.querySelectorAll(".style-row[data-style-path]").forEach(bindStyleRow);
            const up = document.getElementById("macd-up-color");
            const dn = document.getElementById("macd-down-color");
            if (up) up.addEventListener("input", () => { studies.style.macd.upHist = up.value; saveStudies(); renderAllCharts(); });
            if (dn) dn.addEventListener("input", () => { studies.style.macd.downHist = dn.value; saveStudies(); renderAllCharts(); });
        }

        const stochBody = document.getElementById("stoch-style-body");
        if (stochBody) {
            stochBody.innerHTML =
                buildStyleRow("%K", "stoch.k") +
                buildStyleRow("%D", "stoch.d") +
                `<div class="style-row" data-extra="stoch-bands">
                    <label>OB / OS</label>
                    <span></span>
                    <input type="color" id="stoch-ob-color" value="${studies.style.stoch.ob}">
                    <span style="font-size:0.72rem;color:var(--text-secondary);">OB</span>
                    <input type="color" id="stoch-os-color" value="${studies.style.stoch.os}">
                    <span style="font-size:0.72rem;color:var(--text-secondary);">OS</span>
                </div>`;
            stochBody.querySelectorAll(".style-row[data-style-path]").forEach(bindStyleRow);
            const ob = document.getElementById("stoch-ob-color");
            const os = document.getElementById("stoch-os-color");
            if (ob) ob.addEventListener("input", () => { studies.style.stoch.ob = ob.value; saveStudies(); renderAllCharts(); });
            if (os) os.addEventListener("input", () => { studies.style.stoch.os = os.value; saveStudies(); renderAllCharts(); });
        }
    }

    // ── Style popover (color / width / line style for any single line) ──

    function closeStylePopover() {
        const pop = document.getElementById("style-popover");
        if (pop) pop.remove();
        document.removeEventListener("mousedown", outsideStylePopover, true);
        document.removeEventListener("keydown", escClosesStylePopover, true);
    }
    function outsideStylePopover(e) {
        const pop = document.getElementById("style-popover");
        if (pop && !pop.contains(e.target)) closeStylePopover();
    }
    function escClosesStylePopover(e) { if (e.key === "Escape") closeStylePopover(); }

    function prettyLabelForPath(path) {
        if (path.startsWith("ema.")) {
            const slot = parseInt(path.split(".")[1], 10);
            const period = (settings.emaPeriods || [])[slot];
            return `EMA ${period ?? slot + 1}`;
        }
        if (path === "bb.upper") return "Bollinger Bands";
        if (path === "vwap") return "VWAP";
        if (path === "rsi") return "RSI";
        if (path === "sma.short") return `SMA ${settings.smaShort}`;
        if (path === "sma.long") return `SMA ${settings.smaLong}`;
        if (path.startsWith("macd.")) return "MACD · " + path.split(".")[1];
        if (path.startsWith("stoch.")) return "Stoch · " + path.split(".")[1];
        return path;
    }

    // Generic debounce so per-keystroke refetches don't hammer the backend.
    function debounce(fn, ms) {
        let timer = null;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), ms);
        };
    }

    function openStylePopover(path, anchor) {
        closeStylePopover();
        const st = styleAt(path);
        if (!st) return;
        const rect = anchor.getBoundingClientRect();
        const isBB = path === "bb.upper";
        const isEma = path.startsWith("ema.");
        const emaSlot = isEma ? parseInt(path.split(".")[1], 10) : -1;
        const emaPeriod = isEma ? ((settings.emaPeriods || [])[emaSlot] || "") : null;
        const label = prettyLabelForPath(path);
        const styleOpts = LINE_STYLE_OPTIONS.map(o =>
            `<option value="${o.value}" ${o.value === (st.lineStyle || 0) ? "selected" : ""}>${o.label}</option>`
        ).join("");

        const visibleRow = isEma ? `
            <div class="sp-row">
                <label>Visible</label>
                <label class="sp-switch">
                    <input type="checkbox" class="sp-visible" ${isEmaOn(emaSlot) ? "checked" : ""}>
                    <span class="sp-switch-slider"></span>
                </label>
            </div>` : "";

        const daysRow = isEma ? `
            <div class="sp-row">
                <label>Days</label>
                <div class="sp-days-wrap">
                    <button class="sp-step" data-step="-1" title="Decrease">−</button>
                    <input type="number" class="sp-days" min="2" max="500" step="1" value="${emaPeriod}">
                    <button class="sp-step" data-step="1" title="Increase">+</button>
                </div>
            </div>
            <div class="sp-quickdays">
                ${[5, 9, 13, 20, 21, 26, 50, 89, 100, 144, 200].map(p =>
                    `<button class="sp-quick" data-period="${p}" ${p === emaPeriod ? 'data-current' : ""}>${p}</button>`
                ).join("")}
            </div>` : "";

        const pop = document.createElement("div");
        pop.id = "style-popover";
        pop.className = "style-popover" + (isEma ? " sp-wide" : "");
        pop.innerHTML = `
            <div class="sp-header">
                <span class="sp-title">${label}</span>
                <button class="sp-close" title="Close">&times;</button>
            </div>
            ${visibleRow}
            ${daysRow}
            <div class="sp-row">
                <label>Color</label>
                <input type="color" class="sp-color" value="${st.color || "#58a6ff"}">
                <span class="sp-hex">${(st.color || "#58a6ff").toUpperCase()}</span>
            </div>
            <div class="sp-row">
                <label>Width</label>
                <input type="range" class="sp-width" min="1" max="4" step="1" value="${st.width || 2}">
                <span class="sp-width-val">${st.width || 2}px</span>
            </div>
            <div class="sp-row">
                <label>Style</label>
                <select class="sp-style">${styleOpts}</select>
            </div>
            ${isBB ? `
            <div class="sp-row sp-row-multi">
                <label>Bands</label>
                <div class="sp-sub">
                    <span><span class="sp-sub-lbl">Mid</span><input type="color" class="sp-mid" value="${styleAt("bb.middle")?.color || st.color}"></span>
                    <span><span class="sp-sub-lbl">Low</span><input type="color" class="sp-low" value="${styleAt("bb.lower")?.color || st.color}"></span>
                </div>
            </div>` : ""}
            <div class="sp-footer">
                <button class="sp-reset">Reset</button>
            </div>
        `;
        document.body.appendChild(pop);

        // Position the popover near the anchor (clamped to viewport).
        const popRect = pop.getBoundingClientRect();
        let top = rect.bottom + 6;
        let left = rect.left;
        if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
        if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 6;
        pop.style.top = `${Math.max(8, top)}px`;
        pop.style.left = `${Math.max(8, left)}px`;

        const applyAndRender = () => {
            applyStudyButtonStates();
            renderAllCharts();
        };

        // Period change → settings + refetch (debounced).
        const debouncedRefetch = debounce(() => {
            saveSettings();
            renderEmaPills();
            applyStudyButtonStates();
            if (currentTicker) doSearch();
        }, 350);
        const updateDays = (raw, { refetch = true } = {}) => {
            if (!isEma) return;
            const v = parseInt(raw, 10);
            if (!Number.isFinite(v) || v < 2 || v > 500) return;
            settings.emaPeriods = settings.emaPeriods || [];
            while (settings.emaPeriods.length <= emaSlot) settings.emaPeriods.push(0);
            settings.emaPeriods[emaSlot] = v;
            updateIndicatorSummaries();
            // Reflect the new period in the popover title and quick-pill highlighting.
            const titleEl = pop.querySelector(".sp-title");
            if (titleEl) titleEl.textContent = `EMA ${v}`;
            pop.querySelectorAll(".sp-quick").forEach(q => q.toggleAttribute("data-current", parseInt(q.dataset.period, 10) === v));
            if (refetch) debouncedRefetch();
        };

        if (isEma) {
            const daysInput = pop.querySelector(".sp-days");
            daysInput.addEventListener("input", e => updateDays(e.target.value));
            pop.querySelectorAll(".sp-step").forEach(btn => {
                btn.addEventListener("click", () => {
                    const cur = parseInt(daysInput.value, 10) || 1;
                    const delta = parseInt(btn.dataset.step, 10);
                    daysInput.value = Math.max(2, Math.min(500, cur + delta));
                    updateDays(daysInput.value);
                });
            });
            pop.querySelectorAll(".sp-quick").forEach(btn => {
                btn.addEventListener("click", () => {
                    daysInput.value = btn.dataset.period;
                    updateDays(btn.dataset.period);
                });
            });
            pop.querySelector(".sp-visible").addEventListener("change", (e) => {
                studies.ema = studies.ema || {};
                studies.ema[emaSlot] = !!e.target.checked;
                saveStudies();
                applyAndRender();
            });
        }

        pop.querySelector(".sp-color").addEventListener("input", (e) => {
            const color = e.target.value;
            setStyle(path, { color });
            if (path === "bb.upper") setStyle("bb.lower", { color });
            const hex = pop.querySelector(".sp-hex");
            if (hex) hex.textContent = color.toUpperCase();
            applyAndRender();
        });
        pop.querySelector(".sp-width").addEventListener("input", (e) => {
            const width = parseInt(e.target.value, 10);
            setStyle(path, { width });
            pop.querySelector(".sp-width-val").textContent = `${width}px`;
            if (path === "bb.upper") setStyle("bb.lower", { width });
            applyAndRender();
        });
        pop.querySelector(".sp-style").addEventListener("change", (e) => {
            const lineStyle = parseInt(e.target.value, 10);
            setStyle(path, { lineStyle });
            if (path === "bb.upper") setStyle("bb.lower", { lineStyle });
            applyAndRender();
        });
        if (isBB) {
            pop.querySelector(".sp-mid").addEventListener("input", (e) => {
                setStyle("bb.middle", { color: e.target.value });
                applyAndRender();
            });
            pop.querySelector(".sp-low").addEventListener("input", (e) => {
                setStyle("bb.lower", { color: e.target.value });
                applyAndRender();
            });
        }
        pop.querySelector(".sp-reset").addEventListener("click", () => {
            const parts = path.split(".");
            let def = DEFAULT_STUDIES.style;
            for (const p of parts) def = def ? def[p] : null;
            if (def) {
                setStyle(path, { ...def });
                if (path === "bb.upper") {
                    setStyle("bb.middle", { ...DEFAULT_STUDIES.style.bb.middle });
                    setStyle("bb.lower",  { ...DEFAULT_STUDIES.style.bb.lower });
                }
                // For EMA, also restore the default period in this slot.
                if (isEma) {
                    const defPeriods = [9, 21, 50, 200];
                    const defaultPeriod = defPeriods[emaSlot] || (settings.emaPeriods || [])[emaSlot];
                    const daysInput = pop.querySelector(".sp-days");
                    if (daysInput && defaultPeriod) {
                        daysInput.value = defaultPeriod;
                        updateDays(defaultPeriod);
                    }
                }
                closeStylePopover();
                applyAndRender();
            }
        });
        pop.querySelector(".sp-close").addEventListener("click", closeStylePopover);

        // Defer so the click that opened the popover doesn't immediately close it.
        setTimeout(() => {
            document.addEventListener("mousedown", outsideStylePopover, true);
            document.addEventListener("keydown", escClosesStylePopover, true);
        }, 0);
    }

    function renderEmaPills() {
        const container = document.getElementById("ema-pills");
        if (!container) return;
        const periods = (settings.emaPeriods || []).slice(0, 4);
        container.innerHTML = periods.map((p, idx) => {
            const st = styleAt(`ema.${idx}`) || { color: "#58a6ff" };
            // Pencil/edit icon appears on hover and opens the same popover as the dot.
            const editSvg = `<svg class="study-edit" data-style-path="ema.${idx}" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="Edit"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
            return `<button class="study-pill text-pill ema-pill" data-study="ema" data-slot="${idx}" title="Click to toggle · click dot or pencil to edit">
                <span class="study-dot" data-style-path="ema.${idx}" style="background:${st.color}"></span>EMA ${p}${editSvg}
            </button>`;
        }).join("");

        container.querySelectorAll(".study-pill").forEach(btn => {
            btn.addEventListener("click", (e) => {
                // Clicks on the dot or pencil open the popover; everything else toggles.
                if (e.target.closest(".study-dot, .study-edit")) return;
                const slot = parseInt(btn.dataset.slot, 10);
                toggleEma(slot);
                applyStudyButtonStates();
                renderAllCharts();
            });
        });
        wireStyleDots(container);
        // Bind the pencil icon clicks (same handler as the dot).
        container.querySelectorAll(".study-edit[data-style-path]").forEach(icon => {
            if (icon.dataset.wired) return;
            icon.dataset.wired = "1";
            icon.addEventListener("click", (e) => {
                e.stopPropagation();
                openStylePopover(icon.dataset.stylePath, icon);
            });
        });
    }

    function wireStyleDots(scope) {
        (scope || document).querySelectorAll(".study-dot[data-style-path]").forEach(dot => {
            // Make sure we don't double-bind.
            if (dot.dataset.wired) return;
            dot.dataset.wired = "1";
            dot.addEventListener("click", (e) => {
                e.stopPropagation();
                openStylePopover(dot.dataset.stylePath, dot);
            });
        });
    }

    function wireStudiesBar() {
        const bar = document.getElementById("studies-bar");
        if (!bar) return;

        // Chart type pills.
        bar.querySelectorAll("[data-group='chartType'] .study-pill").forEach(btn => {
            btn.addEventListener("click", () => {
                studies.chartType = btn.dataset.type || "candles";
                saveStudies();
                applyStudyButtonStates();
                renderAllCharts();
            });
        });

        // Toggle pills (single-key studies).
        ["bb", "vwap", "volume", "rsi"].forEach(key => {
            const el = bar.querySelector(`[data-study='${key}']`);
            if (!el) return;
            el.addEventListener("click", (e) => {
                if (e.target.classList.contains("study-dot")) return;
                studies[key] = !studies[key];
                saveStudies();
                applyStudyButtonStates();
                renderAllCharts();
            });
        });
        // Give BB / VWAP dots a style-path so they open the popover.
        const bbDot = bar.querySelector("[data-study='bb'] .study-dot");
        if (bbDot) bbDot.dataset.stylePath = "bb.upper";
        const vwDot = bar.querySelector("[data-study='vwap'] .study-dot");
        if (vwDot) vwDot.dataset.stylePath = "vwap";
        wireStyleDots(bar);

        // Log scale.
        const logCb = document.getElementById("study-log");
        if (logCb) {
            logCb.addEventListener("change", () => {
                studies.log = !!logCb.checked;
                saveStudies();
                renderAllCharts();
            });
        }

        // Reset zoom.
        const resetBtn = document.getElementById("study-reset");
        if (resetBtn) {
            resetBtn.addEventListener("click", () => {
                [priceChart, macdChart, stochChart, rsiChart].forEach(c => {
                    if (c) try { c.timeScale().fitContent(); } catch {}
                });
            });
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        loadSettings();
        loadStudies();
        loadWatchlist();
        loadPositions();
        loadTranslations().then(() => { applyLanguage(); populateSettingsUI(); });
        renderWatchlist();
        refreshWatchlistData();
        renderEmaPills();
        applyStudyButtonStates();
        wireStudiesBar();

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
            if (btn.classList.contains("disabled")) return;
            $$(".btn-period").forEach(b => b.classList.remove("active"));
            btn.classList.add("active"); currentPeriod = btn.dataset.period;
            if (currentTicker) doSearch();
        }));

        $$(".btn-interval").forEach(btn => btn.addEventListener("click", () => {
            $$(".btn-interval").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentInterval = btn.dataset.interval;
            applyIntervalConstraints();
            if (currentTicker) doSearch();
        }));
        applyIntervalConstraints();

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
            renderEmaPills();
            applyStudyButtonStates();
            if (currentTicker) doSearch();
        });
        $("#settings-reset").addEventListener("click", () => {
            settings = { ...DEFAULT_SETTINGS, emaPeriods: [...DEFAULT_SETTINGS.emaPeriods] };
            saveSettings();
            populateSettingsUI();
            renderEmaPills();
            applyStudyButtonStates();
        });

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
