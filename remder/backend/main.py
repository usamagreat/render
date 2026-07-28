import json
import logging
import os
import time
from pathlib import Path
from typing import Dict, List, Optional, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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
# Stores the latest snapshot of every data type sent by the child device.
# A newly-connecting parent receives the full snapshot immediately.
last_state: Dict[str, Any] = {}
child_connected_at: Optional[float] = None


# ─── Connection Manager ───────────────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self.parent_connections: List[WebSocket] = []
        self.child_connections:  List[WebSocket] = []

    async def connect(self, websocket: WebSocket, role: str):
        await websocket.accept()
        if role == "parent":
            self.parent_connections.append(websocket)
            logger.info("Parent connected. Total parents: %d", len(self.parent_connections))
            # Send the full current snapshot so the dashboard populates immediately
            if last_state:
                for payload in last_state.values():
                    try:
                        await websocket.send_text(json.dumps(payload))
                    except Exception:
                        pass
        elif role == "child":
            self.child_connections.append(websocket)
            global child_connected_at
            child_connected_at = time.time()
            logger.info("Child connected. Total children: %d", len(self.child_connections))
            await self.broadcast_to_parents(json.dumps({
                "type": "child_status",
                "online": True,
                "connectedAt": int(child_connected_at * 1000)
            }))

    def disconnect(self, websocket: WebSocket, role: str):
        global child_connected_at
        if role == "parent" and websocket in self.parent_connections:
            self.parent_connections.remove(websocket)
            logger.info("Parent disconnected. Remaining: %d", len(self.parent_connections))
        elif role == "child" and websocket in self.child_connections:
            self.child_connections.remove(websocket)
            child_connected_at = None
            logger.info("Child disconnected.")
            import asyncio
            try:
                asyncio.create_task(self.broadcast_to_parents(json.dumps({
                    "type": "child_status",
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

    async def broadcast_to_children(self, message: str):
        dead = []
        for ws in self.child_connections:
            try:
                await ws.send_text(message)
            except Exception as e:
                logger.warning("Dead child removed: %s", e)
                dead.append(ws)
        for ws in dead:
            if ws in self.child_connections:
                self.child_connections.remove(ws)

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
        "childConnectedAt": child_connected_at,
        "parentCount":      len(manager.parent_connections),
        "childCount":       len(manager.child_connections),
        "dataTypes":        list(last_state.keys()),
        "serverTime":       time.time(),
    }

@app.get("/api/snapshot")
async def snapshot():
    """Returns the last known state for all data types."""
    return JSONResponse(content=last_state)


# ─── WebSocket Endpoint ───────────────────────────────────────────────────────

@app.websocket("/ws/{role}")
async def websocket_endpoint(
    websocket: WebSocket,
    role: str,
    token: str = Query(default=""),
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

    await manager.connect(websocket, role)

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
                            if msg_type in ("touch_event", "website_visit"):
                                if msg_type not in last_state:
                                    last_state[msg_type] = {"type": msg_type, "events": []}
                                events = last_state[msg_type]["events"]
                                events.insert(0, payload)
                                last_state[msg_type]["events"] = events[:200]
                            else:
                                last_state[msg_type] = payload
                    except json.JSONDecodeError:
                        pass
                    await manager.broadcast_to_parents(data_str)

                elif role == "parent":
                    await manager.broadcast_to_children(data_str)
                    logger.info("Command → child: %s", data_str[:120])

            elif "bytes" in msg and role == "child":
                await manager.broadcast_to_parents_binary(msg["bytes"])

    except WebSocketDisconnect:
        manager.disconnect(websocket, role)
    except Exception as e:
        logger.error("WS error [%s]: %s", role, e)
        manager.disconnect(websocket, role)


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
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
