"""Trading Journal + Biometrics Server."""

import json
import os
import shutil
import socket
import tempfile
import zipfile
from datetime import datetime
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional

from health_import import import_health_export

from models import get_db, init_db, dict_from_row, dicts_from_rows
from analysis import (
    get_overview, get_correlations, get_insights,
    compute_session_health_summary, compute_readiness,
)

app = FastAPI(title="Trading Journal")


@contextmanager
def db():
    conn = get_db()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# --- Models ---

class SessionStart(BaseModel):
    mood_before: Optional[str] = None
    sleep_hours: Optional[float] = None
    caffeine_cups: Optional[int] = 0
    exercise_today: Optional[int] = 0

class SessionComplete(BaseModel):
    session_rating: Optional[int] = None
    lesson: Optional[str] = None
    notes: Optional[str] = None

class TradeEntry(BaseModel):
    entry_time: Optional[str] = None
    exit_time: Optional[str] = None
    direction: Optional[str] = None
    entry_price: Optional[float] = None
    exit_price: Optional[float] = None
    pnl_pips: Optional[float] = None
    outcome: Optional[str] = None
    per_plan: Optional[int] = 1
    rules_broken: Optional[str] = None
    confidence_before: Optional[int] = None
    emotion_before: Optional[str] = None
    emotion_during: Optional[str] = None
    emotion_after: Optional[str] = None
    notes: Optional[str] = None

class HealthSync(BaseModel):
    session_id: Optional[int] = None
    heart_rate: Optional[list] = None
    hrv: Optional[list] = None
    sleep: Optional[dict] = None

class PreSync(BaseModel):
    sleep_hours: Optional[float] = None
    sleep_start: Optional[str] = None
    sleep_end: Optional[str] = None
    deep_sleep_mins: Optional[int] = None
    rem_sleep_mins: Optional[int] = None
    resting_hr: Optional[float] = None
    hrv: Optional[float] = None


# --- Pre-session sync (from Apple Shortcut) ---

@app.post("/api/pre-sync")
def pre_session_sync(data: PreSync):
    """Receive sleep + resting HR + HRV from Apple Shortcut before starting session.
    Called by the 'Trading Pre-Sync' shortcut on iPhone."""
    # Store in a temp table or return to frontend to auto-fill
    result = {}
    if data.sleep_hours is not None:
        result["sleep_hours"] = round(data.sleep_hours, 1)
    if data.resting_hr is not None:
        result["resting_hr"] = round(data.resting_hr, 1)
    if data.hrv is not None:
        result["hrv"] = round(data.hrv, 1)
    if data.deep_sleep_mins is not None:
        result["deep_sleep_mins"] = data.deep_sleep_mins
    if data.rem_sleep_mins is not None:
        result["rem_sleep_mins"] = data.rem_sleep_mins

    # Compute pre-readiness
    readiness = compute_readiness(
        data.sleep_hours, None, None, resting_hr=data.resting_hr, hrv_avg=data.hrv
    )
    result["readiness_preview"] = readiness
    result["synced"] = True
    return result


# Cache latest pre-sync data so the frontend can poll it
_last_presync = {}

@app.post("/api/pre-sync/push")
def pre_sync_push(data: PreSync):
    """Apple Shortcut calls this. Frontend polls /api/pre-sync/latest."""
    global _last_presync
    _last_presync = {
        "sleep_hours": round(data.sleep_hours, 1) if data.sleep_hours else None,
        "resting_hr": round(data.resting_hr, 1) if data.resting_hr else None,
        "hrv": round(data.hrv, 1) if data.hrv else None,
        "deep_sleep_mins": data.deep_sleep_mins,
        "rem_sleep_mins": data.rem_sleep_mins,
        "synced_at": datetime.now().isoformat(),
    }
    return {"status": "ok", "data": _last_presync}

@app.get("/api/pre-sync/latest")
def pre_sync_latest():
    """Frontend polls this after user runs the shortcut."""
    if not _last_presync:
        return {"synced": False}
    return {"synced": True, **_last_presync}


# --- Session endpoints ---

@app.post("/api/session/start")
def start_session(data: SessionStart):
    with db() as conn:
        # Check if there's already an active session
        active = conn.execute(
            "SELECT id FROM sessions WHERE status='active'"
        ).fetchone()
        if active:
            raise HTTPException(400, "Session already active")

        now = datetime.now().isoformat()
        readiness = compute_readiness(
            data.sleep_hours, data.mood_before, data.caffeine_cups
        )
        cursor = conn.execute(
            "INSERT INTO sessions (start_time, mood_before, sleep_hours, caffeine_cups, "
            "exercise_today, readiness_score, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
            (now, data.mood_before, data.sleep_hours, data.caffeine_cups,
             data.exercise_today, readiness)
        )
        return {
            "id": cursor.lastrowid,
            "start_time": now,
            "readiness_score": readiness,
            "status": "active",
        }


@app.post("/api/session/stop")
def stop_session():
    with db() as conn:
        active = conn.execute(
            "SELECT * FROM sessions WHERE status='active'"
        ).fetchone()
        if not active:
            raise HTTPException(400, "No active session")
        now = datetime.now().isoformat()
        conn.execute(
            "UPDATE sessions SET end_time=?, status='stopped' WHERE id=?",
            (now, active["id"])
        )
        return {"id": active["id"], "end_time": now, "status": "stopped"}


@app.get("/api/session/active")
def get_active_session():
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE status IN ('active','stopped') ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not row:
            return {"active": False}
        session = dict_from_row(row)
        session["active"] = True
        # Attach health summary
        health = compute_session_health_summary(conn, session["id"])
        session["health"] = health
        # Attach trades
        trades = dicts_from_rows(conn.execute(
            "SELECT * FROM trades WHERE session_id=?", (session["id"],)
        ).fetchall())
        session["trades"] = trades
        return session


@app.post("/api/session/{session_id}/complete")
def complete_session(session_id: int, data: SessionComplete):
    with db() as conn:
        session = conn.execute(
            "SELECT * FROM sessions WHERE id=?", (session_id,)
        ).fetchone()
        if not session:
            raise HTTPException(404, "Session not found")
        conn.execute(
            "UPDATE sessions SET status='completed', session_rating=?, lesson=?, notes=? WHERE id=?",
            (data.session_rating, data.lesson, data.notes, session_id)
        )
        return {"id": session_id, "status": "completed"}


@app.post("/api/session/{session_id}/trade")
def add_trade(session_id: int, trade: TradeEntry):
    with db() as conn:
        session = conn.execute(
            "SELECT id FROM sessions WHERE id=?", (session_id,)
        ).fetchone()
        if not session:
            raise HTTPException(404, "Session not found")
        cursor = conn.execute(
            "INSERT INTO trades (session_id, entry_time, exit_time, direction, "
            "entry_price, exit_price, pnl_pips, outcome, per_plan, rules_broken, "
            "confidence_before, emotion_before, emotion_during, emotion_after, notes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, trade.entry_time, trade.exit_time, trade.direction,
             trade.entry_price, trade.exit_price, trade.pnl_pips, trade.outcome,
             trade.per_plan, trade.rules_broken, trade.confidence_before,
             trade.emotion_before, trade.emotion_during, trade.emotion_after,
             trade.notes)
        )
        return {"id": cursor.lastrowid, "session_id": session_id}


@app.delete("/api/trade/{trade_id}")
def delete_trade(trade_id: int):
    with db() as conn:
        conn.execute("DELETE FROM trades WHERE id=?", (trade_id,))
        return {"deleted": trade_id}


# --- Health sync ---

@app.post("/api/health-sync")
def sync_health_data(data: HealthSync):
    """Receive health data from Apple Shortcut."""
    with db() as conn:
        # Find session to attach to
        sid = data.session_id
        if not sid:
            row = conn.execute(
                "SELECT id FROM sessions WHERE status IN ('active','stopped') ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if row:
                sid = row["id"]
        if not sid:
            raise HTTPException(400, "No session to attach health data to")

        count = 0
        if data.heart_rate:
            for sample in data.heart_rate:
                conn.execute(
                    "INSERT INTO health_samples (session_id, timestamp, metric_type, value) "
                    "VALUES (?, ?, 'hr', ?)",
                    (sid, sample.get("timestamp", ""), sample.get("value", 0))
                )
                count += 1

        if data.hrv:
            for sample in data.hrv:
                conn.execute(
                    "INSERT INTO health_samples (session_id, timestamp, metric_type, value) "
                    "VALUES (?, ?, 'hrv', ?)",
                    (sid, sample.get("timestamp", ""), sample.get("value", 0))
                )
                count += 1

        if data.sleep:
            conn.execute(
                "INSERT INTO sleep_data (session_id, sleep_start, sleep_end, duration_hours, "
                "deep_sleep_mins, rem_sleep_mins, awake_mins) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, data.sleep.get("start"), data.sleep.get("end"),
                 data.sleep.get("duration_hours"), data.sleep.get("deep_sleep_mins"),
                 data.sleep.get("rem_sleep_mins"), data.sleep.get("awake_mins"))
            )

            # Update session sleep quality
            hrs = data.sleep.get("duration_hours", 0)
            quality = "good" if hrs >= 7 else ("fair" if hrs >= 6 else "poor")
            conn.execute(
                "UPDATE sessions SET sleep_hours=?, sleep_quality=? WHERE id=?",
                (hrs, quality, sid)
            )

        # Recompute readiness with HRV if available
        if data.hrv:
            session = dict_from_row(conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone())
            hrv_avg = sum(s.get("value", 0) for s in data.hrv) / len(data.hrv) if data.hrv else None
            readiness = compute_readiness(
                session.get("sleep_hours"), session.get("mood_before"),
                session.get("caffeine_cups"), hrv_avg=hrv_avg
            )
            conn.execute("UPDATE sessions SET readiness_score=? WHERE id=?", (readiness, sid))

        return {"synced": count, "session_id": sid}


# --- History ---

@app.get("/api/sessions")
def list_sessions(limit: int = 50):
    with db() as conn:
        sessions = dicts_from_rows(conn.execute(
            "SELECT * FROM sessions WHERE status='completed' ORDER BY start_time DESC LIMIT ?",
            (limit,)
        ).fetchall())
        for s in sessions:
            trades = dicts_from_rows(conn.execute(
                "SELECT * FROM trades WHERE session_id=?", (s["id"],)
            ).fetchall())
            s["trades"] = trades
            s["trade_count"] = len(trades)
            s["health"] = compute_session_health_summary(conn, s["id"])
        return sessions


# --- Health import (Apple Health export) ---

@app.post("/api/health-import")
async def upload_health_export(file: UploadFile = File(...), days_back: int = 30):
    """Upload Apple Health export (export.xml or export.zip) to backfill biometric data."""
    tmp_dir = tempfile.mkdtemp()
    try:
        # Save uploaded file
        tmp_file = os.path.join(tmp_dir, file.filename or "export")
        with open(tmp_file, "wb") as f:
            content = await file.read()
            f.write(content)

        # Handle zip file
        if file.filename and file.filename.endswith(".zip"):
            with zipfile.ZipFile(tmp_file, "r") as z:
                z.extractall(tmp_dir)
            os.remove(tmp_file)
            # Find export.xml inside
            xml_path = tmp_dir
        else:
            xml_path = tmp_file

        result = import_health_export(xml_path, days_back)
        return {"status": "ok", **result}
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Import failed: {str(e)}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# --- Analysis ---

@app.get("/api/analysis/overview")
def analysis_overview():
    with db() as conn:
        return get_overview(conn)

@app.get("/api/analysis/correlations")
def analysis_correlations():
    with db() as conn:
        return get_correlations(conn)

@app.get("/api/analysis/insights")
def analysis_insights():
    with db() as conn:
        return get_insights(conn)


# --- Server info ---

@app.get("/api/server-info")
def server_info():
    """Return local IP for Apple Shortcut setup."""
    hostname = socket.gethostname()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = "127.0.0.1"
    return {"hostname": hostname, "local_ip": local_ip, "port": 8440}


# --- Static files ---

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def index():
    return FileResponse("static/index.html")


# --- Init ---

@app.on_event("startup")
def startup():
    init_db()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8440)
