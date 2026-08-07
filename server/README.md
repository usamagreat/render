# SafeWatch Backend Server

This folder contains the complete backend Node.js server for the SafeWatch Parent Control application. It provides the REST API, WebSocket server for real-time communication, and hosts the Web Dashboard.

## Features
- **Express.js REST API**: Device registration, historical data querying.
- **WebSocket Server**: Real-time live feed, status updates, and command dispatching (Lock, Capture Photo, Record Audio, etc.).
- **SQLite Database**: Uses `node-sqlite3-wasm` (pure WASM, requires no native compilers or C++ build tools on Windows). Stores devices, state, locations, app usage, call logs, SMS logs, and commands.
- **Web Dashboard**: Premium dark-mode dashboard served automatically.

## How to Deploy to Render.com

Render is a great platform for this because it provides a free tier and supports Node.js natively. The repository already includes a `render.yaml` configuration file.

### Step 1: Push to GitHub
1. Create a new empty repository on GitHub (e.g., `safewatch-server`).
2. Upload the contents of **THIS FOLDER** (`server`) to the root of that GitHub repository. You should see `package.json`, `server.js`, `render.yaml`, etc., directly in the root of the repo.

### Step 2: Deploy on Render
1. Go to [Render.com](https://render.com) and sign in.
2. Click **New +** and select **Blueprint**.
3. Connect your GitHub account and select the repository you just created (`safewatch-server`).
4. Render will automatically detect the `render.yaml` file.
5. Click **Apply Blueprint**.
6. Render will start building and deploying your Node.js application.

### Step 3: Get your Server URL
1. Once deployed, Render will give you a URL (e.g., `https://safewatch-server-xxxx.onrender.com`).
2. Update your Android App's `ServerConfig.kt` to point to this new URL.

## Local Development (Windows / Mac / Linux)

If you want to run the server locally on your computer for testing:

1. Open a terminal/command prompt in this `server` folder.
2. Ensure you have [Node.js](https://nodejs.org/) installed.
3. Run `npm install` to install dependencies.
4. Run `npm start` (or `npm run dev` for auto-restarting).
5. The dashboard will be available at `http://localhost:3000`.

## Database
The database is stored locally in `data/parent_control.db` using SQLite. On Render, the free tier uses an ephemeral disk, meaning the database will be cleared if the server restarts. If you upgrade to a paid Render plan, you can attach a persistent Disk to `/opt/render/project/src/data` to keep data permanently.
