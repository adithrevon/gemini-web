# Project Memory

## Important Rules

1. **Do NOT modify Gemini CLI files** - Only modify the bridge file
   (`packages/web/server.mjs`) and the iOS app (`gemini-app/`). The Gemini CLI
   code in `packages/cli/` should never be touched.

2. **Do NOT run the server** - Never start or restart the server (`npm start`).
   The user will manage the server themselves.

3. **Integration tests are REQUIRED for new features** - All new backend
   features MUST include integration tests. See
   [packages/web/CLAUDE.md](./packages/web/CLAUDE.md) for testing requirements
   and patterns. Minimum 80% coverage for new code.

## Repository Overview

This repository is a **fork of Google Gemini CLI**.

We have added two new packages:

1. **`packages/web/` (gemini-web)** - Backend API server (Node.js HTTP +
   WebSocket) - no frontend
2. **`./gemini-app/` (gemini-app)** - Native iOS/macOS SwiftUI client app (the
   only frontend)

## Architecture

The iOS app is the sole frontend. It connects to the gemini-web backend server
which spawns and manages CLI instances.

```
iOS App (gemini-app)
    ↓ HTTP/SSE
Backend Server (gemini-web)
    ↓ WebSocket
Gemini CLI instances
```

## Architecture Documentation

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation on:

- gemini-web backend API endpoints
- gemini-app iOS app structure and components
- Communication protocols (SSE, WebSocket)
- Environment variables

## Quick Reference

- **Backend server port**: 7337
- **iOS app connects to**: `http://127.0.0.1:7337`
- **Start backend**: `cd packages/web && npm start`

## iOS App Build & Deploy

After making changes to the iOS app (`gemini-app/`), always build, verify, and
install to the connected iOS device:

```bash
# Build
xcodebuild -scheme gemini-app -destination 'id=00008130-00045D8434E0001C' -configuration Debug build

# Install to device
xcrun devicectl device install app --device 00008130-00045D8434E0001C ~/Library/Developer/Xcode/DerivedData/gemini-app-cqhbwsmyhoyrffdkocuwhppwfawj/Build/Products/Debug-iphoneos/gemini-app.app

# Launch on device
xcrun devicectl device process launch --device 00008130-00045D8434E0001C com.prem.gemini-app
```
