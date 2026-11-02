# CESMII Smart Manufacturing Catalog — listing sheet

Fields follow what the Catalog shows on every entry (catalog.cesmii.net): name, vendor, description,
tags, SM imperative, category, asset link, vendor website, images. Image URLs below assume the repo is
public at the asset link; Jonathan links them from there.

| Field | Value |
|---|---|
| Name | i3X Media Bridge (MediaMTX) |
| Vendor | CivOps |
| Vendor website | https://civops.io |
| SM imperative | i3X |
| Category | Open Source |
| License | MIT |
| Asset link | https://github.com/Civops-Platform/i3x-media-bridge |
| Tags | #Video #Audio #Cameras #MediaMTX #RTSP #WebRTC #Alarms #OpenSource |
| Hero image | `catalog/hero-1600x900.png` → https://raw.githubusercontent.com/Civops-Platform/i3x-media-bridge/main/catalog/hero-1600x900.png |
| Image source | `catalog/src/hero.html` (rendered by `catalog/render.sh`, headless Chrome at 1600×900) |
| Vendor logo | `catalog/civops-logo-light.png` (light backgrounds), `catalog/civops-logo-dark.png` (dark), 800×192; SVG sources in `catalog/src/` |

## Description (short — the line under the title)

Puts plant cameras and microphones into an i3X address space through MediaMTX: stream health as ordinary values, a signed link for each viewer, and a clip cut automatically when an alarm trips.

## Description (long)

The video itself never goes through the i3X API. MediaMTX, the open-source media server, pulls each camera over RTSP, keeps a short rolling recording, and serves viewers over WebRTC, RTSP or HLS. The bridge handles the parts an i3X server has to decide for itself.

Stream health comes back as plain values: online, bitrate, viewer count and tracks. A camera that sends nothing reads online = false at Good quality, because that is a true statement about the camera, while a gateway that stops answering turns every one of those values Bad. A camera going dark ends up as a quality change like any other tag, which beats finding out from a frozen picture on the line supervisor's screen.

Viewers get a link carrying a signed token for that one stream, good for ten minutes. MediaMTX asks the bridge about every request it receives. A viewer without a valid token for that exact path is turned away, and nobody is allowed to publish, the server's own credentials included, since devices are pulled and never pushed to.

When an alarm trips, the bridge cuts a clip from the recording a few seconds either side of it, waits for the recording segment to close if it has to, and hands the MP4 to your media store marked as documenting the alarm and captured by that camera.

TypeScript on Node 22, MIT licensed, no runtime dependencies. The unit tests run against a stand-in for the MediaMTX API, and an end-to-end script runs the whole thing against MediaMTX 1.9.3 with an ffmpeg test pattern playing the part of the camera.
