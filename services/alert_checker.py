import time
import logging
import threading
from services.alerts import get_active_alerts, mark_triggered, update_last_signal
from services.scanner import _compute_signal_fast
from services.stock_data import normalize_ticker
from services.yf_session import Ticker, yf_fetch_with_retry
from services.email_sender import (
    send_alert_email, build_signal_email, build_price_email
)

logger = logging.getLogger(__name__)

CHECK_INTERVAL = 900  # 15 minutes

_thread = None
_running = False


def start_checker():
    global _thread, _running
    if _thread and _thread.is_alive():
        return
    _running = True
    _thread = threading.Thread(target=_loop, daemon=True)
    _thread.start()
    logger.info("Alert checker background thread started")


def stop_checker():
    global _running
    _running = False


def _loop():
    time.sleep(30)  # let the app warm up
    while _running:
        try:
            _check_all()
        except Exception as e:
            logger.error(f"Alert checker error: {e}")
        time.sleep(CHECK_INTERVAL)


def _check_all():
    alerts = get_active_alerts()
    if not alerts:
        return
    logger.info(f"Checking {len(alerts)} active alerts")

    for alert in alerts:
        try:
            if alert["type"] == "signal":
                _check_signal_alert(alert)
            elif alert["type"] == "price":
                _check_price_alert(alert)
        except Exception as e:
            logger.warning(f"Failed checking alert {alert['id']}: {e}")


def _check_signal_alert(alert):
    symbol = normalize_ticker(alert["ticker"], alert["market"])
    result = _compute_signal_fast(symbol)
    if not result:
        return

    action = result["action"]
    prev = alert.get("lastSignal")
    update_last_signal(alert["id"], action)

    if prev is None:
        return

    if action != prev and action in ("BUY", "SELL"):
        subject, html = build_signal_email(
            alert["ticker"], action, result["price"],
            result["signals"], alert["market"]
        )
        sent = send_alert_email(subject, html, alert["email"])
        if sent:
            mark_triggered(alert["id"], rearm=True)
            logger.info(f"Signal alert fired: {alert['ticker']} {prev} → {action}")


def _check_price_alert(alert):
    symbol = normalize_ticker(alert["ticker"], alert["market"])
    stock = Ticker(symbol)
    try:
        df = yf_fetch_with_retry(lambda: stock.history(period="5d", interval="1d"))
        if df.empty:
            return
        current = float(df["Close"].iloc[-1])
    except Exception:
        return

    target = float(alert["condition"].get("price", 0))
    direction = alert["condition"].get("direction", "above")

    if direction == "above" and current >= target:
        subject, html = build_price_email(
            alert["ticker"], target, current, "above", alert["market"]
        )
        sent = send_alert_email(subject, html, alert["email"])
        if sent:
            mark_triggered(alert["id"])
    elif direction == "below" and current <= target:
        subject, html = build_price_email(
            alert["ticker"], target, current, "below", alert["market"]
        )
        sent = send_alert_email(subject, html, alert["email"])
        if sent:
            mark_triggered(alert["id"])
