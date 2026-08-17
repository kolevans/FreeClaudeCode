<p align="center">
  <img src="assets/banner.svg" alt="FreeClaudeCode" width="100%" />
</p>

<h1 align="center">FreeClaudeCode</h1>

<p align="center">
  <b>Free Claude Code stack — in one clean UI</b><br/>
  OmniRoute + Kiro + models + launch. No setup hell.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/macOS-12%2B-000000?logo=apple&logoColor=white" alt="macOS" />
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/Release-v1.3.2-7c6cff" alt="Release" />
  <img src="https://img.shields.io/badge/UI-EN%20%2F%20RU-7c6cff" alt="Languages" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT" />
</p>

<p align="center">
  <a href="https://github.com/kolevans/FreeClaudeCode/releases/latest">⬇️ Download</a> ·
  <a href="#-features">✨ Features</a> ·
  <a href="#-quick-start">🚀 Quick start</a> ·
  <a href="https://t.me/loveaideep">💬 Telegram</a>
</p>

<p align="center">
  <img src="assets/screenshot.png" alt="FreeClaudeCode dashboard" width="900" />
</p>

---

## ✨ Features

| | |
|---|---|
| 🧰 **All-in-one stack** | Node · OmniRoute · Claude Code — from one panel |
| 🔑 **Kiro login** | Device code + auto API key |
| 🧠 **Model switcher** | Pick a model, check status, go |
| ▶️ **One-click launch** | Open Claude Code on the active model |
| 📦 **Portable build** | Zip → extract → run |

---

## ⬇️ Download

1. Get the ZIP from **[Releases](https://github.com/kolevans/FreeClaudeCode/releases/latest)**
2. Extract → run `FreeClaude.exe`
3. Open `http://127.0.0.1:3847`
4. Settings → Kiro → Models → Launch

> Latest: **v1.3.2** — Axiom prompt ships with the build: turn it on in Settings and
> it installs into Claude Code. Also includes the 1.3.1 launch / OmniRoute fixes.

> Needs **Node.js 22+** for OmniRoute key management — the installer sets it up for you,
> or point FreeClaude at an existing copy with the gear icon on the Node.js card.

> Copy the **whole folder** to another PC.

---

## 🚀 Quick start

```powershell
git clone https://github.com/kolevans/FreeClaudeCode.git
cd FreeClaudeCode
npm install
node server.js
```

UI → `http://127.0.0.1:3847` · OmniRoute → `http://127.0.0.1:20128`

<details>
<summary>📦 Manual install (optional)</summary>

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g omniroute @anthropic-ai/claude-code
omniroute
```

</details>

---

## 🏗️ Build EXE

```powershell
.\build-release.ps1
```

Output: `..\dist\FreeClaude\`

---

## 📁 Structure

```text
server.js          # app + setup + Kiro
omni-keys.js       # OmniRoute keys
public/            # UI
build-release.ps1  # portable pack
assets/            # media
```

---

## 🔐 Notes

- Data: `%APPDATA%\FreeClaude`, `~\.omniroute`, `~\.claude`
- Password env: `OMNIROUTE_PASSWORD` / `INITIAL_PASSWORD` (default `CHANGEME`)
- Don’t commit personal keys

---

## 🤝 Contributors

| | |
|---|---|
| [@kolevans](https://github.com/kolevans) | Creator & maintainer |
| [@Azamaperdeev05](https://github.com/Azamaperdeev05) | macOS support: bash launcher, cross-platform fixes, crypto module fix |

---

<p align="center">
  MIT · <a href="https://t.me/loveaideep">@loveaideep</a>
</p>
