# RiskGuard Market Data Worker

Separate worker process for market data ingestion.

- Backfills last 30 days of M5 and H1 candles for the default watchlist on first run
- Keeps M1 and M5 candles up to date (stream or poll) with exponential backoff
- Retention: M1 for 7 days, M5 for 90 days, H1/D for 2 years
- Market-closed detection (weekend/holidays) - does not treat as outage
- Never exposes provider tokens to the browser
- All DB access via Prisma with respect to provider limits
