import json
import logging
import os
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
PAIRING_TOKEN = os.environ.get("SAFEWATCH_TOKEN", "safewatch2024")

# ─── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="SafeWatch Relay Server", version="5.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── In-memory state ──────────────────────────────────────────────────────────
last_state: Dict[str, Dict[str, Any]] = {}
child_connected_at: Dict[str, float] = {}
alert_numbers_store: Dict[str, str] = {}   # deviceId → comma-separated numbers


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
            if last_state:
                for d_id, state in last_state.items():
                    for payload in state.values():
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
    return {"status": "ok", "service": "SafeWatch Relay v5.0"}

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
    return JSONResponse(content=last_state)

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), token: str = Query(...)):
    if token != PAIRING_TOKEN:
        return {"error": "Invalid token"}
    temp_dir = Path("/tmp/safewatch_uploads")
    temp_dir.mkdir(parents=True, exist_ok=True)
    file_path = temp_dir / file.filename
    with open(file_path, "wb") as buffer:
        buffer.write(await file.read())
    
    await manager.broadcast_to_parents(json.dumps({
        "type": "file_ready",
        "filename": file.filename,
        "url": f"/api/download/{file.filename}?token={token}"
    }))
    return {"status": "ok", "filename": file.filename}

@app.get("/api/download/{filename}")
async def download_file(filename: str, token: str = Query(...)):
    if token != PAIRING_TOKEN:
        return {"error": "Invalid token"}
    file_path = Path("/tmp/safewatch_uploads") / filename
    if not file_path.exists():
        return {"error": "File not found"}
    return FileResponse(file_path)


# ─── Alert Numbers API (persisted in memory across sessions) ──────────────────

@app.get("/api/alert-numbers")
async def get_alert_numbers(token: str = Query(default=""), device_id: str = Query(default="")):
    if token != PAIRING_TOKEN:
        return JSONResponse(status_code=401, content={"error": "Invalid token"})
    return {"numbers": alert_numbers_store.get(device_id, ""), "deviceId": device_id}

@app.post("/api/alert-numbers")
async def set_alert_numbers(body: dict, token: str = Query(default="")):
    if token != PAIRING_TOKEN:
        return JSONResponse(status_code=401, content={"error": "Invalid token"})
    device_id = body.get("device_id", "")
    numbers   = body.get("numbers", "")
    if device_id:
        alert_numbers_store[device_id] = numbers
        logger.info("Alert numbers updated for %s: %s", device_id, numbers)
    return {"status": "ok", "device_id": device_id, "numbers": numbers}


@app.websocket("/ws/{role}")
async def websocket_endpoint(
    websocket: WebSocket,
    role: str,
    token: str = Query(default=""),
    device_id: str = Query(default=""),
):
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

                        # Silently discard heartbeat — no need to forward to parents
                        if msg_type == "heartbeat":
                            try:
                                await websocket.send_text(json.dumps({"type": "pong", "ts": time.time()}))
                            except Exception:
                                pass
                            continue

                        if msg_type:
                            payload["deviceId"] = device_id
                            if device_id not in last_state:
                                last_state[device_id] = {}

                            if msg_type in ("touch_event", "website_visit", "social_chats", "app_switch", "call_alert"):
                                if msg_type not in last_state[device_id]:
                                    last_state[device_id][msg_type] = {"type": msg_type, "events": []}
                                events = last_state[device_id][msg_type]["events"]
                                events.insert(0, payload)
                                last_state[device_id][msg_type]["events"] = events[:200]
                            else:
                                last_state[device_id][msg_type] = payload

                        data_str = json.dumps(payload)
                    except json.JSONDecodeError:
                        pass
                    await manager.broadcast_to_parents(data_str)

                elif role == "parent":
                    try:
                        payload = json.loads(data_str)
                        cmd = payload.get("command")
                        target = payload.get("target_device", "")
                        
                        if cmd == "RENAME_DEVICE":
                            new_name = payload.get("name", "")
                            if target and new_name:
                                await manager.broadcast_to_parents(json.dumps({
                                    "type": "device_renamed",
                                    "deviceId": target,
                                    "name": new_name
                                }))
                        
                        await manager.broadcast_to_children(data_str, target)
                        logger.info("Command → child [%s]: %s", target, data_str[:120])
                    except json.JSONDecodeError:
                        pass

            elif "bytes" in msg and role == "child":
                await manager.broadcast_to_parents_binary(msg["bytes"])

    except WebSocketDisconnect:
        manager.disconnect(websocket, role, device_id)
    except Exception as e:
        logger.error("WS error [%s]: %s", role, e)
        manager.disconnect(websocket, role, device_id)


# ─── Static Files — Dashboard ─────────────────────────────────────────────────
_dashboard_dir = Path(__file__).parent.parent / "dashboard"
if _dashboard_dir.exists():
    app.mount("/", StaticFiles(directory=str(_dashboard_dir), html=True), name="dashboard")
    logger.info("Dashboard mounted from: %s", _dashboard_dir)
else:
    logger.warning("Dashboard directory not found at %s — serving API only", _dashboard_dir)

    @app.get("/")
    async def root():
        return {
            "service": "SafeWatch Relay v5.0",
            "status": "running",
            "childOnline": manager.child_online(),
            "parents": len(manager.parent_connections),
            "dashboard": "not found — deploy with dashboard/ folder",
        }


# ─── Entry point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
