import os
import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

logger = logging.getLogger(__name__)

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587


def send_alert_email(subject: str, html_body: str, recipient: str = None) -> bool:
    sender = os.environ.get("SMTP_EMAIL", "")
    password = os.environ.get("SMTP_PASSWORD", "")
    to_addr = recipient or os.environ.get("ALERT_RECIPIENT", sender)

    if not sender or not password:
        logger.warning("SMTP_EMAIL or SMTP_PASSWORD not configured — skipping email")
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"Victor's Vector <{sender}>"
    msg["To"] = to_addr
    msg.attach(MIMEText(html_body, "html"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
            server.starttls()
            server.login(sender, password)
            server.sendmail(sender, to_addr, msg.as_string())
        logger.info(f"Alert email sent to {to_addr}: {subject}")
        return True
    except Exception as e:
        logger.error(f"Failed to send email: {e}")
        return False


def build_signal_email(ticker: str, action: str, price: float,
                       signals: list, market: str) -> tuple[str, str]:
    color = "#3fb950" if action == "BUY" else "#f85149" if action == "SELL" else "#d29922"
    signal_rows = "".join(
        f'<tr><td style="padding:6px 12px;border-bottom:1px solid #30363d">{s["ind"]}</td>'
        f'<td style="padding:6px 12px;border-bottom:1px solid #30363d;font-weight:600">{s["sig"]}</td></tr>'
        for s in signals
    )
    subject = f"{'🟢' if action == 'BUY' else '🔴' if action == 'SELL' else '🟡'} {action} Signal — {ticker}"
    html = f"""
    <div style="font-family:'Inter',Arial,sans-serif;background:#0d1117;color:#e6edf3;padding:32px;max-width:480px;margin:auto;border-radius:12px">
        <h2 style="margin:0 0 8px">Victor's Vector Alert</h2>
        <div style="background:{color};color:#fff;display:inline-block;padding:6px 18px;border-radius:8px;font-weight:700;font-size:1.2rem;margin-bottom:16px">{action}</div>
        <p style="font-size:1.1rem;margin:12px 0"><strong>{ticker}</strong> ({market.upper()}) at <strong>${price:.2f}</strong></p>
        <table style="width:100%;border-collapse:collapse;background:#161b22;border-radius:8px;overflow:hidden;margin:16px 0">
            <tr style="background:#21262d"><th style="padding:8px 12px;text-align:left">Indicator</th><th style="padding:8px 12px;text-align:left">Signal</th></tr>
            {signal_rows}
        </table>
        <p style="color:#8b949e;font-size:0.8rem;margin-top:20px">This is an automated alert from Victor's Vector. Not financial advice.</p>
    </div>"""
    return subject, html


def build_price_email(ticker: str, target: float, current: float,
                      direction: str, market: str) -> tuple[str, str]:
    emoji = "📈" if direction == "above" else "📉"
    subject = f"{emoji} {ticker} crossed {'above' if direction == 'above' else 'below'} ${target:.2f}"
    html = f"""
    <div style="font-family:'Inter',Arial,sans-serif;background:#0d1117;color:#e6edf3;padding:32px;max-width:480px;margin:auto;border-radius:12px">
        <h2 style="margin:0 0 8px">Victor's Vector Price Alert</h2>
        <p style="font-size:1.1rem;margin:12px 0"><strong>{ticker}</strong> ({market.upper()}) crossed <strong>{'above' if direction == 'above' else 'below'}</strong> your target of <strong>${target:.2f}</strong></p>
        <p style="font-size:1.3rem;font-weight:700;margin:16px 0">Current Price: ${current:.2f}</p>
        <p style="color:#8b949e;font-size:0.8rem;margin-top:20px">This is an automated alert from Victor's Vector. Not financial advice.</p>
    </div>"""
    return subject, html
