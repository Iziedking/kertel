# Execution evidence

This directory contains redacted records from live Telt runs.

Each record keeps the market, side, quantity, status, mandate limits, and observed position while omitting credentials and account identifiers. A SHA-256 digest detects later changes to the exported record.

These files document what an authenticated Binance account displayed at the stated observation time. They are not Binance-signed receipts. Where client attribution matters, the exchange record must be reconciled with Telt's durable operation journal and deterministic client order ID.
