import json
import logging
import os
import shutil
import time
from pathlib import Path
from typing import Dict, List, Optional, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

# ─── Config ───────────────────────────────────────────────────────────────────
# Set SAFEWATCH_TOKEN in Render environment variables for security.
# Default is "safewatch2024" — CHANGE before going live.
PAIRING_TOKEN = os.environ.get("SAFEWATCH_TOKEN", "safewatch2024")

# ─── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="SafeWatch Relay Server", version="4.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── In-memory state ──────────────────────────────────────────────────────────
# Stores the latest snapshot of every data type sent by the child device, keyed by device_id.
# A newly-connecting parent receives the full snapshot immediately.
last_state: Dict[str, Dict[str, Any]] = {}
child_connected_at: Dict[str, float] = {}


# ─── Connection Manager ───────────────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self.parent_connections: List[WebSocket] = []
        self.child_connections:  Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, role: str, device_id: str = ""):
        await websocket.accept()
        if role == "parent":
            self.parent_connections.append(websocket)
            logger.info("Parent connected. Total parents: %d", len(self.parent_connections))
            # Send the full current snapshot so the dashboard populates immediately
            if last_state:
                for d_id, state in last_state.items():
                    for payload in state.values():
                        # Inject device_id so parent knows where it came from if not present
                        if isinstance(payload, dict):
                            payload["deviceId"] = d_id
                        try:
                            await websocket.send_text(json.dumps(payload))
                        except Exception:
                            pass
        elif role == "child":
            if device_id:
                self.child_connections[device_id] = websocket
                global child_connected_at
                child_connected_at[device_id] = time.time()
                logger.info("Child %s connected. Total children: %d", device_id, len(self.child_connections))
                await self.broadcast_to_parents(json.dumps({
                    "type": "child_status",
                    "deviceId": device_id,
                    "online": True,
                    "connectedAt": int(child_connected_at[device_id] * 1000)
                }))

    def disconnect(self, websocket: WebSocket, role: str, device_id: str = ""):
        global child_connected_at
        if role == "parent" and websocket in self.parent_connections:
            self.parent_connections.remove(websocket)
            logger.info("Parent disconnected. Remaining: %d", len(self.parent_connections))
        elif role == "child" and device_id in self.child_connections:
            if self.child_connections[device_id] == websocket:
                del self.child_connections[device_id]
                child_connected_at.pop(device_id, None)
                logger.info("Child %s disconnected.", device_id)
                import asyncio
                try:
                    asyncio.create_task(self.broadcast_to_parents(json.dumps({
                        "type": "child_status",
                        "deviceId": device_id,
                        "online": False
                    })))
                except Exception:
                    pass

    async def broadcast_to_parents(self, message: str):
        dead = []
        for ws in self.parent_connections:
            try:
                await ws.send_text(message)
            except Exception as e:
                logger.warning("Dead parent removed: %s", e)
                dead.append(ws)
        for ws in dead:
            if ws in self.parent_connections:
                self.parent_connections.remove(ws)

    async def broadcast_to_parents_binary(self, data: bytes):
        dead = []
        for ws in self.parent_connections:
            try:
                await ws.send_bytes(data)
            except Exception as e:
                logger.warning("Dead parent (binary): %s", e)
                dead.append(ws)
        for ws in dead:
            if ws in self.parent_connections:
                self.parent_connections.remove(ws)

    async def broadcast_to_children(self, message: str, target_device: str = ""):
        if target_device and target_device in self.child_connections:
            try:
                await self.child_connections[target_device].send_text(message)
            except Exception as e:
                logger.warning("Dead child removed: %s", e)
                del self.child_connections[target_device]
        elif not target_device:
            # Broadcast to all if no target specified
            dead = []
            for d_id, ws in self.child_connections.items():
                try:
                    await ws.send_text(message)
                except Exception as e:
                    logger.warning("Dead child removed: %s", e)
                    dead.append(d_id)
            for d_id in dead:
                self.child_connections.pop(d_id, None)

    def child_online(self) -> bool:
        return len(self.child_connections) > 0


manager = ConnectionManager()


# ─── REST Endpoints ───────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Render health check endpoint."""
    return {"status": "ok", "service": "SafeWatch Relay v4.0"}

@app.get("/api/status")
async def status():
    return {
        "childOnline":      manager.child_online(),
        "connectedDevices": list(manager.child_connections.keys()),
        "childConnectedAt": child_connected_at,
        "parentCount":      len(manager.parent_connections),
        "childCount":       len(manager.child_connections),
        "dataTypes":        {d: list(s.keys()) for d, s in last_state.items()},
        "serverTime":       time.time(),
    }

@app.get("/api/snapshot")
async def snapshot():
    """Returns the last known state for all devices."""
    return JSONResponse(content=last_state)

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), token: str = Query(...)):
    if token != PAIRING_TOKEN:
        return {"error": "Invalid token"}

    temp_dir = Path("/tmp/safewatch_uploads")
    temp_dir.mkdir(parents=True, exist_ok=True)

    # Sanitize filename to prevent path traversal
    safe_name = Path(file.filename).name if file.filename else "upload"
    file_path  = temp_dir / safe_name

    # FIX: Stream file to disk in 64 KB chunks instead of await file.read().
    # await file.read() loads the ENTIRE file into RAM first — this crashes on large files.
    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer, length=64 * 1024)
    except Exception as e:
        logger.error("Upload write error: %s", e)
        return {"error": f"Upload failed: {e}"}

    file_size = file_path.stat().st_size
    logger.info("Uploaded: %s (%s bytes)", safe_name, file_size)

    # Notify all connected parents that a file is ready for download
    await manager.broadcast_to_parents(json.dumps({
        "type":     "file_ready",
        "filename": safe_name,
        "size":     file_size,
        "sizeMB":   round(file_size / 1_048_576, 2),
        "url":      f"/api/download/{safe_name}?token={token}"
    }))
    return {"status": "ok", "filename": safe_name, "size": file_size}

@app.get("/api/download/{filename}")
async def download_file(filename: str, token: str = Query(...)):
    if token != PAIRING_TOKEN:
        return {"error": "Invalid token"}

    # Sanitize: prevent path traversal
    safe_name = Path(filename).name
    file_path  = Path("/tmp/safewatch_uploads") / safe_name
    if not file_path.exists():
        return {"error": "File not found — it may have been cleaned up. Re-download from device."}

    # FIX: Add Content-Disposition header so browsers save the file with the
    # correct filename instead of displaying it or saving as 'download'.
    return FileResponse(
        path=str(file_path),
        filename=safe_name,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'}
    )

@app.get("/api/files")
async def list_files(token: str = Query(...)):
    """Lists all files currently available for download."""
    if token != PAIRING_TOKEN:
        return {"error": "Invalid token"}
    temp_dir = Path("/tmp/safewatch_uploads")
    if not temp_dir.exists():
        return {"files": []}
    files = [
        {
            "filename": f.name,
            "size":     f.stat().st_size,
            "sizeMB":   round(f.stat().st_size / 1_048_576, 2),
            "url":      f"/api/download/{f.name}?token={PAIRING_TOKEN}",
            "modified": f.stat().st_mtime
        }
        for f in temp_dir.iterdir() if f.is_file()
    ]
    files.sort(key=lambda x: x["modified"], reverse=True)
    return {"files": files, "count": len(files)}


# ─── WebSocket Endpoint ───────────────────────────────────────────────────────

@app.websocket("/ws/{role}")
async def websocket_endpoint(
    websocket: WebSocket,
    role: str,
    token: str = Query(default=""),
    device_id: str = Query(default=""),
):
    """
    role = 'child' or 'parent'
    Both sides must pass ?token=PAIRING_TOKEN.

    Child  → sends JSON data + binary media frames
    Parent → receives all child data; sends JSON commands back to child
    """
    if token != PAIRING_TOKEN:
        await websocket.close(code=4001, reason="Invalid token")
        logger.warning("Rejected: bad token=%r role=%s", token, role)
        return

    if role not in ("parent", "child"):
        await websocket.close(code=4000, reason="Invalid role")
        return

    await manager.connect(websocket, role, device_id)

    try:
        while True:
            msg = await websocket.receive()

            if "text" in msg:
                data_str = msg["text"]

                if role == "child":
                    try:
                        payload  = json.loads(data_str)
                        msg_type = payload.get("type")
                        if msg_type:
                            payload["deviceId"] = device_id
                            # ensure device exists in state
                            if device_id not in last_state:
                                last_state[device_id] = {}

                            if msg_type in ("touch_event", "website_visit"):
                                if msg_type not in last_state[device_id]:
                                    last_state[device_id][msg_type] = {"type": msg_type, "events": []}
                                events = last_state[device_id][msg_type]["events"]
                                events.insert(0, payload)
                                last_state[device_id][msg_type]["events"] = events[:200]
                            elif msg_type in ("camera_frame", "audio_chunk"):
                                # FIX: Do NOT cache streaming data in last_state.
                                # camera_frame / audio_chunk are live media — caching them
                                # wastes memory and sends stale frames to newly connected parents.
                                pass
                            else:
                                last_state[device_id][msg_type] = payload

                        data_str = json.dumps(payload)
                    except json.JSONDecodeError:
                        pass
                    await manager.broadcast_to_parents(data_str)

                elif role == "parent":
                    try:
                        payload = json.loads(data_str)
                        target = payload.get("target_device", "")
                        await manager.broadcast_to_children(data_str, target)
                        logger.info("Command → child [%s]: %s", target, data_str[:120])
                    except json.JSONDecodeError:
                        pass

            elif "bytes" in msg and role == "child":
                # Currently binary broadcast sends raw bytes, which doesn't include deviceId.
                # To support multiple cameras concurrently, we should ideally prepend the deviceId
                # to the bytes, but for now we broadcast as-is.
                await manager.broadcast_to_parents_binary(msg["bytes"])

    except WebSocketDisconnect:
        manager.disconnect(websocket, role, device_id)
    except Exception as e:
        logger.error("WS error [%s]: %s", role, e)
        manager.disconnect(websocket, role, device_id)


# ─── Static Files — Dashboard ─────────────────────────────────────────────────
# Mount the dashboard folder so Render serves both the relay AND the UI.
# WebSocket endpoints (/ws/*) and API (/api/*, /health) are registered above
# and take priority over the static file handler.
_dashboard_dir = Path(__file__).parent.parent / "dashboard"
if _dashboard_dir.exists():
    app.mount("/", StaticFiles(directory=str(_dashboard_dir), html=True), name="dashboard")
    logger.info("Dashboard mounted from: %s", _dashboard_dir)
else:
    logger.warning("Dashboard directory not found at %s — serving API only", _dashboard_dir)

    # Fallback root for when only the backend folder is deployed
    @app.get("/")
    async def root():
        return {
            "service": "SafeWatch Relay v4.0",
            "status": "running",
            "childOnline": manager.child_online(),
            "parents": len(manager.parent_connections),
            "dashboard": "not found — deploy with dashboard/ folder",
        }


# ─── Entry point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    # IMPORTANT: Two separate size limits must BOTH be raised:
    #
    # 1. ws_max_size  — uvicorn's WebSocket frame size limit.
    #    Default: 16 MB (uvicorn). This is usually fine for camera frames.
    #
    # 2. The `websockets` library (used by uvicorn) also has its own max_size=1MB.
    #    This is what was silently dropping file messages > 1MB.
    #    Passing ws_max_size to uvicorn propagates it to the websockets library too.
    #
    # For file downloads we now bypass WebSocket entirely for files > 500KB,
    # but we still raise the limit here for camera frames (JPEG ~5-50KB each).
    WS_MAX = 16 * 1024 * 1024   # 16 MB — handles camera frames safely
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        ws_max_size=WS_MAX,
    )
