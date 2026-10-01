# Virtual ONVIF Server — Samsung Legacy Camera Edition

A virtual ONVIF Profile S server that bridges **legacy Samsung cameras** (SNH-V6414N and similar) to strict ONVIF clients such as the **Dahua XVR16CH series DVR**.

Originally forked from [daniela-hase/onvif-server](https://github.com/daniela-hase/onvif-server), this fork adds:

- ✅ Full ONVIF compliance for strict DVR clients (Dahua XVR)
- ✅ Samsung-specific device identity in `GetDeviceInformation`
- ✅ Configurable `hostname` — no MAC address / macvlan needed on Windows
- ✅ Additional required endpoints: `GetNetworkInterfaces`, `GetUsers`, `GetScopes`, `GetScopes`, `SystemReboot`
- ✅ WS-Discovery with correct RFC namespaces and scopes
- ✅ Memory leak fixes + graceful shutdown (from upstream PR #26)
- ✅ PTZ passthrough and audio advertisement (from upstream PR #28)
- ✅ ONVIF compliance test suite (Jest)
- ✅ Multi-platform Docker CI (amd64 + arm64)

---

## Table of Contents

1. [Hardware Setup](#1-hardware-setup)
2. [Prerequisites](#2-prerequisites)
3. [Installation](#3-installation)
4. [Configuration](#4-configuration)
5. [Running the Server](#5-running-the-server)
6. [Docker](#6-docker)
7. [RTSP Paths for Samsung Cameras](#7-rtsp-paths-for-samsung-cameras)
8. [Audio Support](#8-audio-support-optional)
9. [PTZ Passthrough](#9-ptz-passthrough-optional)
10. [Running the Tests](#10-running-the-tests)
11. [Troubleshooting](#11-troubleshooting)
12. [ONVIF Compliance Notes](#12-onvif-compliance-notes)

---

## 1. Hardware Setup

This server acts as a **middleman**:

```
Dahua XVR DVR  ←—ONVIF—→  [this server]  ←—RTSP proxy—→  Samsung Camera
```

- The **Dahua XVR** discovers and talks to the virtual ONVIF devices created by this server.
- This server **TCP proxies** RTSP and snapshot traffic to the real Samsung camera.
- No changes are required on the Samsung camera itself.

**Tested with:**
- DVR:    Dahua XVR16CH-2AI (ONVIF 3.1, firmware V4.004.0000001.0.R)
- Camera: Samsung SNH-V6414N/US

---

## 2. Prerequisites

- **Node.js v18+** (check with `node -v`)
- **Windows** (or Linux/macOS/Raspberry Pi)

Install Node.js on Windows: download from [nodejs.org](https://nodejs.org/)

> **Linux/macvlan users**: If your ONVIF client (e.g., Unifi Protect) identifies cameras by MAC address, you still need to create macvlan interfaces. See the original README for instructions. For Dahua XVRs — not needed.

---

## 3. Installation

```powershell
# Clone the repo
git clone https://github.com/your-fork/onvif-server-samsung.git
cd onvif-server-samsung

# Install dependencies
npm install
```

---

## 4. Configuration

Copy the example config and edit it:

```powershell
copy onvif.yaml.example onvif.yaml
```

Then open `onvif.yaml` and fill in your values:

```yaml
onvif:
  - hostname: 192.168.1.100      # IP of the machine running this server
    ports:
      server:   8081             # ONVIF HTTP port (one per virtual camera)
      rtsp:     8554             # local RTSP passthrough port
      snapshot: 8580             # local snapshot passthrough port

    name: SamsungCamera1         # friendly name, no spaces
    uuid: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  # unique per camera

    deviceInfo:
      manufacturer:    Samsung
      model:           SNH-V6414N
      firmwareVersion: "2.10.00_b43"
      serialNumber:    SNH-V6414N-0001
      hardwareId:      SNH-V6414N-1001

    highQuality:
      rtsp:      /profile5/media.smp
      snapshot:  /onvif/snapshot
      width:     1920
      height:    1080
      framerate: 15
      bitrate:   2048
      quality:   4

    lowQuality:
      rtsp:      /profile1/media.smp
      snapshot:  /onvif/snapshot
      width:     640
      height:    360
      framerate: 15
      bitrate:   512
      quality:   1

    target:
      hostname: 192.168.1.200    # actual IP of the Samsung camera
      ports:
        rtsp:     554
        snapshot: 80
```

### Generating a UUID

```powershell
node -e "console.log(require('node-uuid').v4())"
```

### Multiple cameras

Add more entries under `onvif:`, incrementing the port numbers:

```yaml
onvif:
  - hostname: 192.168.1.100
    ports: { server: 8081, rtsp: 8554, snapshot: 8580 }
    name: SamsungCamera1
    uuid: ...
    ...

  - hostname: 192.168.1.100
    ports: { server: 8082, rtsp: 8555, snapshot: 8581 }
    name: SamsungCamera2
    uuid: ...
    ...
```

### Auto-generate config from existing ONVIF camera

If your Samsung camera already speaks ONVIF:

```powershell
node main.js --create-config
```

Enter the camera IP:port, username, and password. Paste the output into `onvif.yaml` and adjust `hostname` and `deviceInfo`.

---

## 5. Running the Server

```powershell
# Normal mode
node main.js onvif.yaml

# Debug mode (verbose ONVIF, HTTP, RTSP, snapshot, PTZ, and discovery diagnostics)
node main.js --debug onvif.yaml
```

Debug mode logs each HTTP endpoint request and response status/duration, SOAP operation and sanitized request XML, RTSP methods/statuses, snapshot generation outcomes, PTZ relay results, and WS-Discovery probes/replies. ONVIF server logs are prefixed with the configured camera name to distinguish multiple cameras. SOAP authentication values and RTSP URL credentials/query strings are not included in these diagnostics. Use the `GetProfile` token and response status in the logs to check whether the Dahua's profile request is reaching the server and which configured profile is returned.
It also logs each SOAP response's HTTP status and byte count; `GetProfiles` includes the number of profiles returned. If the client repeats `GetProfiles` without requesting `GetStreamUri`, check for a non-200 SOAP response or an unexpected profile count. Fault bodies are not printed in response diagnostics.

You should see output like:

```
info Starting ONVIF server for 'SamsungCamera1' on 192.168.1.100:8081 ...
info   Started!
info Starting TCP proxy :8554 → 192.168.1.200:554 ...
info   Started!
```

The Dahua XVR should discover the camera automatically within a few seconds via WS-Discovery (UDP multicast on port 3702).

> **Windows Firewall**: Allow Node.js through the firewall, or open ports 8081, 8554, 8580, and 3702/UDP manually.

---

## 6. Docker

```bash
# Run with your config file
docker run --rm -it \
  --network host \
  -v /path/to/your/onvif.yaml:/onvif.yaml \
  ghcr.io/rmcclell/onvif-server-samsunng:latest

# Generate a config from inside the container
docker run --rm -it \
  --network host \
  --entrypoint /bin/sh \
  ghcr.io/rmcclell/onvif-server-samsunng:latest
# then: node main.js --create-config
```

> Use `--network host` so the container can join the multicast group for WS-Discovery.

---

## 7. RTSP Paths for Samsung Cameras

Samsung SmartCam cameras use paths like `/profileN/media.smp`. Common values:

| Profile | Resolution  | Typical Path             |
|---------|-------------|--------------------------|
| Main HD | 1920×1080   | `/profile5/media.smp`    |
| Main    | 1280×720    | `/profile1/media.smp`    |
| Sub     | 640×360     | `/profile2/media.smp`    |

> If you're unsure, install **ONVIF Device Manager** (free Windows tool) and open the stream from there — it will show the correct path.

**Full RTSP URL format:**
```
rtsp://admin:password@192.168.1.200:554/profile5/media.smp
```

> The username/password in the RTSP URL are for the Samsung camera's own auth (entered in the Dahua XVR during camera setup). The `onvif.yaml` config does **not** store camera credentials.

### Direct RTSP URLs (Python proxy compatibility)

If the DVR connects with the Python proxy but not the TCP-proxied stream, set
`highQuality.rtsp` and (if used) `lowQuality.rtsp` to the camera's complete
`rtsp://` URLs instead of paths. The server then advertises those URLs directly
in `GetStreamUri`; path-only values still use the local TCP proxy. The DVR
must be able to reach the camera and authenticate to it directly.

If the camera has no HTTP snapshot endpoint, omit `highQuality.snapshot`
(and `lowQuality.snapshot` if applicable). For direct RTSP URLs the server
advertises `/snapshot.jpg` and generates JPEG frames using **FFmpeg**, which
must be installed and available on the server's `PATH`. An explicitly configured
snapshot path continues to use the existing HTTP snapshot proxy. Avoid
embedding credentials in the YAML RTSP URL: it is returned to ONVIF clients.

---

## 8. Audio Support (optional)

If the Samsung camera has a microphone, enable audio advertisement so the Dahua XVR records audio:

```yaml
    audio: true
```

Or with explicit settings:

```yaml
    audio:
      encoding: AAC
      bitrate: 64
      samplerate: 16
```

The audio bytes already flow through the RTSP TCP proxy unchanged — this only tells the DVR that the virtual camera has a microphone.

> **Note**: The Dahua XVR only detects audio at camera adoption time. If you add audio to an existing camera, you must re-add it in the DVR.

---

## 9. PTZ Passthrough (optional)

If the real camera supports pan/tilt/zoom, add a `ptz:` block:

```yaml
    ptz:
      port: 8080               # ONVIF port on the real camera
      username: admin          # used once at startup for profile discovery only
      password: 4321
      # profileToken: '001'   # optional: force a specific camera profile
```

PTZ requests from the Dahua XVR are relayed to the real camera transparently, with profile tokens rewritten as needed.

---

## 10. Running the Tests

```powershell
npm test
```

The test suite (`test/onvif-compliance.test.js`) validates all ONVIF handlers against the Profile S specification, including edge cases that strict DVR clients exercise.

```
PASS test/onvif-compliance.test.js
  GetSystemDateAndTime
    ✓ returns DateTimeType
    ✓ has DaylightSavings boolean
    ✓ has TimeZone.TZ string starting with UTC
    ...
  GetCapabilities
    ✓ returns all capabilities when Category omitted
    ...
  GetDeviceInformation
    ✓ returns Manufacturer
    ✓ returns Model
    ...
```

---

## 11. Troubleshooting

### Dahua XVR doesn't discover the camera

- Ensure the server machine and XVR are on the **same subnet**.
- Check Windows Firewall — allow inbound UDP on port 3702 and TCP on your server ports.
- Try adding the camera manually in the XVR using the server's IP and port 8081.
- Enable debug mode: `node main.js --debug onvif.yaml`

### ONVIF Device Manager / other clients report "Access Error" or "no endpoint listening"

- Use the ONVIF server port (`ports.server`), not the snapshot or RTSP proxy ports — those forward raw traffic to the real camera.
- Device service URL: `http://<hostname>:<ports.server>/onvif/device_service` (the base URL `http://<hostname>:<ports.server>/onvif/` is also accepted).

### "address already in use" (EADDRINUSE) on startup

The server aborts with exit code 1 when a configured address/port cannot be bound. This almost always means another instance is still running (for example a systemd service, a Docker container, or a previous run left in the background).

- Find the owner of the port: `ss -lptn 'sport = :8081'`
- Stop the other instance: `systemctl stop onvif-server` or `pkill -f "node main.js"`
- Or change `ports.server`, `ports.rtsp` and `ports.snapshot` in the config so each camera uses unique, free ports.

### npm fails with an ICU error on Alpine

If even `node -e "console.log(Intl.DateTimeFormat().resolvedOptions())"` fails, the issue is with the Node/ICU installation, not the server. On Alpine with Node 24 and `icu-data-en`, install `icu-data-full` (`apk add --no-cache icu-data-full`), verify that Node command succeeds, then run `npm ci` again. A native Node crash during npm installation cannot be caught by the server.

If the server reports a missing npm package, run `npm ci` in the project directory. For direct RTSP URLs without a snapshot path, generated snapshots require FFmpeg on `PATH`; install `ffmpeg` if snapshot requests report it missing.

### RTSP stream shows as "offline" or fails

- Verify the Samsung camera RTSP path with VLC:  
  `rtsp://admin:password@192.168.1.200:554/profile5/media.smp`
- Check that the `rtsp` port in your config matches what the camera is actually serving.
- Samsung cameras support **limited concurrent streams** — disconnect other viewers.

### "Wsse authorized time check failed"

The Dahua XVR rejects requests if clocks differ by more than 5 minutes. Sync the XVR and server clocks. The server always returns the current system time via `GetSystemDateAndTime`.

### All cameras show the same stream

Each virtual camera needs a unique `uuid` and unique port numbers in the config.

### Audio not recording in Dahua XVR

Add `audio: true` to the config and then **re-add the camera** in the XVR (Dahua only detects audio at adoption time).

### Connection refused on snapshot

If you haven't set a `snapshot` URL on the camera, the server serves a placeholder PNG. The Dahua XVR may show a static image rather than a live snapshot — this is normal.

---

## 12. ONVIF Compliance Notes

This server implements **ONVIF Profile S** with the following endpoints:

| Endpoint | Service | Notes |
|---|---|---|
| `GetSystemDateAndTime` | Device | Returns current system time |
| `SetSystemDateAndTime` | Device | Accepted (no-op) |
| `GetCapabilities` | Device | Device + Media (+ PTZ if configured) |
| `GetServices` | Device | Returns all active services |
| `GetServiceCapabilities` | Device | Returns minimal capabilities |
| `GetDeviceInformation` | Device | Samsung-specific by default |
| `GetNetworkInterfaces` | Device | Returns adapter info |
| `GetNetworkDefaultGateway` | Device | Stub response |
| `GetDNS` | Device | Stub response |
| `GetNTP` | Device | Stub response |
| `GetUsers` | Device | Returns empty list |
| `GetScopes` | Device | Returns proper ONVIF scopes |
| `SystemReboot` | Device | Accepted (no-op) |
| `GetProfiles` | Media | Main + Sub stream profiles |
| `GetProfile` | Media | By token |
| `GetVideoSources` | Media | Single video source |
| `GetVideoSourceConfigurations` | Media | Per profile |
| `GetVideoEncoderConfigurations` | Media | Per profile |
| `GetAudioSources` | Media | If `audio:` configured |
| `GetAudioSourceConfigurations` | Media | If `audio:` configured |
| `GetAudioEncoderConfigurations` | Media | If `audio:` configured |
| `GetAudioEncoderConfiguration` | Media | If `audio:` configured |
| `GetAudioEncoderConfigurationOptions` | Media | If `audio:` configured |
| `GetStreamUri` | Media | RTSP URI via TCP proxy |
| `GetSnapshotUri` | Media | HTTP URI via TCP proxy |
| WS-Discovery | UDP 3702 | RFC-compliant ProbeMatch |

---

## Credits

- Original project: [daniela-hase/onvif-server](https://github.com/daniela-hase/onvif-server)
- Memory leak fixes: upstream PR #26 (statico)
- PTZ/audio passthrough: upstream PR #28 (coolham123)
- Samsung / Dahua XVR adaptations: this fork