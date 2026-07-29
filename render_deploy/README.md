# 🛡️ SafeWatch — Parental Control System

A complete parental safety monitoring system consisting of:
- **Android Child App** — runs on the child's phone, streams all data
- **Python Relay Server** — bridges the child device and parent dashboard via WebSocket
- **Parent Dashboard** — web UI to monitor and control the child's device

> ⚠️ **This tool is designed for transparent, consensual use by parents to monitor their own child's device. Always inform your child that monitoring is active.**

---

## 📁 Project Structure

```
parent control tool/
├── android/                  ← Android Studio project (child app)
│   └── app/src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/safewatch/child/
│       │   ├── MainActivity.kt
│       │   ├── MonitoringService.kt
│       │   ├── WebSocketManager.kt
│       │   ├── BootReceiver.kt
│       │   ├── collectors/          ← Battery, Network, GPS, Calls, SMS, Storage, Camera, Mic
│       │   ├── accessibility/       ← TouchLoggerService (touch + browser URL)
│       │   └── admin/               ← AdminReceiver (device lock)
│       └── res/
├── backend/                  ← FastAPI relay server
│   ├── main.py
│   └── requirements.txt
└── dashboard/                ← Parent web dashboard
    ├── index.html
    ├── style.css
    └── app.js
```

---

## 🚀 Setup Guide

### Step 1 — Start the Relay Server

```bash
cd backend
pip install -r requirements.txt
python main.py
```

Server starts at `http://0.0.0.0:8000`. Note your **PC's local IP address** (e.g., `192.168.1.100`).

> **Change the pairing token** in `backend/main.py` line 20:
> ```python
> PAIRING_TOKEN = "your_strong_secret_token"
> ```

---

### Step 2 — Open the Parent Dashboard

Open `dashboard/index.html` in any modern browser.

- Set **Server URL** to: `ws://YOUR_PC_IP:8000/ws/parent`
- Enter your **Pairing Token**
- Click **Connect**

---

### Step 3 — Build & Install the Android App

1. Open Android Studio
2. Open the `android/` folder as a project
3. In `res/values/strings.xml`, set the default server URL:
   ```xml
   <string name="default_server_url">ws://YOUR_PC_IP:8000/ws/child</string>
   ```
4. Click **Build → Build APK** or press **Run (▶)**
5. Install on the child's Android device (Android 8.0+)

---

### Step 4 — Set Up the Child Device

Launch **SafeWatch** on the child's device and complete all setup steps:

| Step | What to do |
|------|-----------|
| 1 | Enter the server URL and pairing token |
| 2 | Tap "Grant All Permissions" — approve all system dialogs |
| 3 | Go to **Settings → Apps → SafeWatch → App Usage Access** → enable |
| 4 | Go to **Settings → Security → Device Admin** → enable SafeWatch |
| 5 | Go to **Settings → Accessibility → SafeWatch Touch Monitor** → enable |
| 6 | Tap "Start Monitoring" |

The app will auto-start after device reboot.

---

## 🔧 Features

| Feature | How It Works |
|---------|-------------|
| **Ghost Mode 👻** | App hides its launcher icon and masks itself as "Android System Service" |
| **Live Battery** | BroadcastReceiver → streamed every 30s |
| **IP Addresses** | WifiManager + NetworkInterface → every 30s |
| **Live Location** | FusedLocationProvider (getCurrentLocation for Android 13+) → every 10s |
| **Call Logs & Alerts** | CallLog content provider; Real-time popup alerts for specific numbers |
| **SMS Logs** | SMS content provider → every 60s |
| **App Control** | UsageStatsManager → every 60s; parent can block |
| **Website History** | AccessibilityService reads Chrome/Firefox URL bar |
| **Social Media Chats** | Tracks incoming/outgoing messages on WhatsApp, Instagram, Telegram, etc. |
| **Storage Manager** | StatFs → internal + category breakdown, plus file download support |
| **Live Camera & Recording** | Camera2 API → Live feed & remote video recording (Front/Back) |
| **Live Mic & Recording** | AudioRecord → Live audio monitoring & remote audio recording |
| **Remote Uninstall** | Send an uninstall command directly from the dashboard |
| **Lock Device** | DevicePolicyManager.lockNow() |

---

## 📡 WebSocket Protocol

All messages are JSON. The child sends data; the parent receives it and sends commands.

### Child → Server → Parent (data)
```json
{ "type": "battery", "percentage": 78, "status": "Discharging", ... }
{ "type": "location", "lat": 28.6139, "lng": 77.2090, "accuracy": 12.5, ... }
{ "type": "calls", "logs": [...], "count": 25 }
{ "type": "camera_frame", "data": "<base64 JPEG>", "ts": 1234567890 }
{ "type": "touch_event", "eventType": "TAP", "package": "com.app", "description": "..." }
```

### Parent → Server → Child (commands)
```json
{ "command": "LOCK_DEVICE" }
{ "command": "START_CAMERA", "facing": "back" }
{ "command": "STOP_CAMERA" }
{ "command": "START_RECORDING_CAMERA", "facing": "front", "duration": 60000 }
{ "command": "START_MIC" }
{ "command": "STOP_MIC" }
{ "command": "START_RECORDING_MIC", "duration": 60000 }
{ "command": "BLOCK_APP", "package": "com.example.app" }
{ "command": "UNBLOCK_APP", "package": "com.example.app" }
{ "command": "SET_CALL_ALERTS", "numbers": "+1234567890" }
{ "command": "GET_SNAPSHOT" }
{ "command": "UNINSTALL_APP" }
```

---

## 🔒 Security Notes

- Change the `PAIRING_TOKEN` to a long random string before real use
- For use over the internet (not just LAN), add TLS: run behind an **nginx reverse proxy with SSL** or use a service like **ngrok**
- The app requires many sensitive permissions — only install on devices you own

---

## 🐛 Troubleshooting

| Issue | Fix |
|-------|-----|
| Dashboard shows "Disconnected" | Check server is running and URL is correct |
| No location data | Ensure "Always Allow" location is set in Settings |
| No call/SMS logs | Check READ_CALL_LOG and READ_SMS permissions |
| Camera not streaming | Enable camera permission; check Camera2 support |
| Touch events not showing | Enable Accessibility Service in Android Settings |
| App blocked not working | Enable Accessibility Service |
| No app usage data | Enable "Usage Access" in Android Settings |
