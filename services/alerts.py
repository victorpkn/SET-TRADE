import time
import uuid
import logging

logger = logging.getLogger(__name__)

_alerts = []


def create_alert(alert_type: str, ticker: str, market: str,
                 email: str, condition: dict = None) -> dict:
    alert = {
        "id": uuid.uuid4().hex[:12],
        "type": alert_type,  # "signal" or "price"
        "ticker": ticker.upper(),
        "market": market,
        "email": email,
        "condition": condition or {},
        "active": True,
        "triggered": False,
        "lastSignal": None,
        "createdAt": time.time(),
        "triggeredAt": None,
    }
    _alerts.append(alert)
    logger.info(f"Alert created: {alert['id']} — {alert_type} for {ticker}")
    return alert


def get_alerts(email: str = None) -> list:
    if email:
        return [a for a in _alerts if a["email"] == email]
    return list(_alerts)


def delete_alert(alert_id: str) -> bool:
    global _alerts
    before = len(_alerts)
    _alerts = [a for a in _alerts if a["id"] != alert_id]
    return len(_alerts) < before


def get_active_alerts() -> list:
    return [a for a in _alerts if a["active"] and not a["triggered"]]


def mark_triggered(alert_id: str, rearm: bool = False):
    for a in _alerts:
        if a["id"] == alert_id:
            a["triggered"] = True
            a["triggeredAt"] = time.time()
            if not rearm:
                a["active"] = False
            break


def update_last_signal(alert_id: str, signal: str):
    for a in _alerts:
        if a["id"] == alert_id:
            a["lastSignal"] = signal
            break
