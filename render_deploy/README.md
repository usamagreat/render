# 🛡️ SafeWatch — Parental Control Tool v5

Real-time parental monitoring system for Android devices.

---

## 📁 Project Structure

```
SafeWatch/
├── android/                      ← Android child-device app (build in Android Studio)
│   └── app/src/main/
│       ├── AndroidManifest.xml
│       └── java/com/safewatch/child/
│           ├── MonitoringService.kt     (core background service)
│           ├── WebSocketManager.kt      (auto-reconnecting WebSocket)
│           ├── MainActivity.kt          (setup UI)
│           ├── ServerConfig.kt          ← EDIT THIS with your Render URL
│           ├── BootReceiver.kt
│           ├── RestartReceiver.kt
│           ├── DeviceStateReceiver.kt
│           ├── ServiceWatchdogJob.kt    (JobScheduler keep-alive)
│           ├── KeepAliveWorker.kt       (WorkManager keep-alive)
│           ├── accessibility/
│           │   └── TouchLoggerService.kt
│           ├── admin/
│           │   └── AdminReceiver.kt
│           └── collectors/
│               ├── AppUsageCollector.kt
│               ├── AudioRecorder.kt
│               ├── BatteryCollector.kt
│               ├── CallAlertReceiver.kt
│               ├── CallLogCollector.kt
│               ├── CameraStreamer.kt
│               ├── LocationCollector.kt
│               ├── MicStreamer.kt
│               ├── NetworkCollector.kt
│               ├── PhoneStateWatcher.kt
│               ├── SmsCollector.kt
│               ├── StorageCollector.kt
│               └── VideoRecorder.kt
│
├── render_deploy/                ← Upload THIS folder to GitHub for Render deployment
│   ├── backend/
│   │   ├── main.py              (FastAPI relay server)
│   │   ├── requirements.txt
│   │   ├── Procfile
│   │   └── render.yaml          (Render service config — optional, root one preferred)
│   └── dashboard/
│       ├── index.html           (parent web dashboard)
│       ├── style.css
│       └── app.js
│
├── render.yaml                   ← Render auto-deploy config (root)
├── .gitignore
└── README.md
```

---

## 🚀 Deployment Guide

### Step 1 — Deploy Backend to Render

1. Push this entire repo to **GitHub**
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Render will auto-detect `render.yaml` and configure the service
5. After deploy, copy your Render URL e.g. `your-app.onrender.com`

**Or manual Render setup:**
- **Root Directory:** `render_deploy/backend`
- **Build Command:** `pip install -r requirements.txt`
- **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
- **Environment Variable:** `SAFEWATCH_TOKEN` = your secret token

### Step 2 — Configure Android App

Edit [`android/app/src/main/java/com/safewatch/child/ServerConfig.kt`](android/app/src/main/java/com/safewatch/child/ServerConfig.kt):

```kotlin
private const val RENDER_HOST = "your-app.onrender.com"   // ← your Render URL
const val TOKEN = "your-secret-token"                       // ← match SAFEWATCH_TOKEN env var
```

### Step 3 — Build & Install Android App

1. Open `android/` in **Android Studio**
2. Let Gradle sync
3. Build → **Generate Signed APK** (or Run on device)
4. Install on child's device
5. Grant all requested permissions
6. App auto-starts monitoring and hides its icon after 3 seconds

### Step 4 — Access Dashboard

Open `https://your-app.onrender.com` in your browser.

Add `?token=your-secret-token` to the URL if token-protected:
```
https://your-app.onrender.com?token=your-secret-token
```

---

## ✨ Features (v5)

| Feature | Details |
|---------|---------|
| 📍 **GPS Location** | FusedLocationProvider — on-demand high-accuracy fix, screen-off works |
| 📱 **App Usage** | Accessibility + UsageStats merged — no permission needed for basic tracking |
| 📞 **Call Alerts** | Persistent — set once, remembered forever. Works on Android 10-16 |
| 💬 **Social Chats** | WhatsApp, Telegram, Instagram, Snapchat, Discord, Signal + 16 more |
| 🔋 **Battery & Device** | Real-time battery stats |
| 📡 **Network** | WiFi SSID, IP, carrier, connection type |
| 📷 **Live Camera** | JPEG stream + video recording |
| 🎤 **Live Mic** | PCM stream + audio recording |
| 💾 **Storage** | File browser, download any file |
| 🌐 **Website History** | Browser URL capture via Accessibility |
| 🔒 **Device Lock** | Remote screen lock via Device Admin |
| 👻 **Ghost Mode** | Icon hidden from launcher (app still runs) |
| ♾️ **24/7 Keep-Alive** | JobScheduler + WorkManager + AlarmManager + 5 restart mechanisms |
| 📴 **Screen-Off** | Dual WakeLock + setExactAndAllowWhileIdle — runs with screen off |
| 🔕 **Silent Notification** | IMPORTANCE_NONE channel — no visible notification on Android 10-16 |
| 🔁 **Auto-Reconnect** | WebSocket reconnects every 10s with heartbeat ping |

---

## 🔧 Android Permissions Required

The app will prompt for all of these during setup:

- **Location** (Fine + Background) — GPS tracking
- **Call Logs + SMS** — phone activity
- **Camera + Microphone** — live streaming
- **Accessibility Service** — app usage, social chats, browser URLs
- **Device Admin** — screen lock
- **Draw Over Other Apps** — invisible overlay (keeps app alive)
- **All Files Access** — file browser
- **App Usage Stats** — detailed usage tracking
- **Battery Optimization Exempt** — prevents system killing the service

---

## 🛠️ Technical Notes

- **Render free tier**: Server sleeps after 15min inactivity. The Android app reconnects automatically.
- **Token security**: Change `SAFEWATCH_TOKEN` env var on Render from the default `safewatch2024`.
- **File uploads** go to `/tmp/safewatch_uploads/` — these are wiped on Render restart (free tier).
- **Android 10+**: Call number may show as "Unknown" due to OS privacy restrictions — call state (RINGING/DIALING) is still reported.
- **App icon restore**: To show the app icon again, send `SHOW_APP` command from dashboard, or run:
  ```bash
  adb shell pm enable com.safewatch.child/.MainActivity
  ```
