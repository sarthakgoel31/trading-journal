# Trading Journal

**Trading session analytics with Apple Watch biometric correlation.**

A lightweight trading journal that goes beyond P&L tracking. Log sessions with pre-trade mood, caffeine intake, and sleep data, then correlate outcomes with Apple Watch biometrics (heart rate, HRV, sleep stages) to find what actually drives your best and worst trades.

## Features

- **Session Management** -- Start/stop trading sessions with pre-trade context (mood, sleep, caffeine, exercise)
- **Trade Logging** -- Entry/exit prices, direction, P&L in pips, plan adherence, rules broken
- **Emotion Tracking** -- Capture emotional state before, during, and after each trade
- **Apple Watch Integration** -- Import HealthKit data (heart rate, HRV, sleep stages) via XML export
- **Readiness Score** -- Composite score from sleep, HRV, and resting heart rate to gauge trading fitness
- **Biometric Correlations** -- Statistical analysis of how sleep quality, heart rate variability, and caffeine affect win rate
- **Pattern Insights** -- Discover which moods, times of day, and physical states produce your best results
- **Plan Adherence Metrics** -- Track how often you follow your trading plan and how rule-breaking correlates with losses
- **Single-File Frontend** -- Clean dashboard UI served as static HTML, no build step required

## Architecture

```
trading-journal/
  server.py            -- FastAPI application (all API routes)
  models.py            -- SQLite schema and database helpers
  analysis.py          -- Correlation engine and insight generation
  health_import.py     -- Apple Health XML parser
  static/
    index.html         -- Dashboard UI
    style.css          -- Styles
    app.js             -- Frontend logic
  data/
    trading_journal.db -- SQLite database (auto-created)
```

## Tech Stack

| Component | Technology |
|---|---|
| Backend | Python, FastAPI |
| Database | SQLite (WAL mode) |
| Health Data | Apple HealthKit XML export |
| Frontend | Vanilla HTML/CSS/JS |
| Analysis | Python statistics module |

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Start the server
uvicorn server:app --host 0.0.0.0 --port 8430 --reload
```

Open [http://localhost:8430](http://localhost:8430) to access the dashboard.

## Apple Watch Data Import

1. Open the **Health** app on your iPhone
2. Tap your profile picture, then **Export All Health Data**
3. Upload the `export.zip` file through the dashboard's health sync page

The importer extracts heart rate samples, HRV readings, and sleep analysis data, linking them to your trading sessions by timestamp.

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/sessions` | Start a new trading session |
| `PUT` | `/sessions/{id}/complete` | End a session with rating and notes |
| `POST` | `/sessions/{id}/trades` | Log a trade within a session |
| `POST` | `/health/sync` | Sync Apple Watch biometrics |
| `POST` | `/health/pre-sync` | Pre-session readiness data |
| `POST` | `/health/import` | Upload Health export ZIP |
| `GET` | `/analysis/overview` | Aggregate performance stats |
| `GET` | `/analysis/correlations` | Biometric-outcome correlations |
| `GET` | `/analysis/insights` | Pattern-based trading insights |

---

Built with [Claude Code](https://claude.ai/code)
