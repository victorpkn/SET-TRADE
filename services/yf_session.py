import yfinance as yf
from curl_cffi import requests as cffi_requests

_session = cffi_requests.Session(impersonate="chrome")


def Ticker(symbol: str) -> yf.Ticker:
    return yf.Ticker(symbol, session=_session)
