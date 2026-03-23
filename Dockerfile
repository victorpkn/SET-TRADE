FROM python:3.11

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    python -c "from curl_cffi import requests; s = requests.Session(impersonate='chrome'); print('curl_cffi OK')"

COPY . .

CMD gunicorn app:app --bind 0.0.0.0:$PORT
