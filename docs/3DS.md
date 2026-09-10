# New Nintendo 3DS

The upper screen displays video. The lower screen provides fixed tiles for
play/pause, ten-second skips, progress, volume and the queue. Browsing the queue
keeps the video mounted. Touch scrubbing previews a position on the device and
sends **one seek when the contact ends**. L/R skip, START toggles playback,
B switches to browsing, X opens search, and A activates the focused control.

The layout follows the separated viewing and control areas in
[Samsung Flex mode](https://developer.samsung.com/codelab/galaxy-z/flex-mode.html)
and the continuity guidance in Apple's
[Designing for iPhone Duo](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo).
It uses explicit tiles sized for a 320×240 resistive touch display. Search uses
30-pixel-high keyboard keys. This is an adaptation of those interaction
principles, not a reproduction of an iPhone interface.

## Install and connect

Requirements: New 3DS with a homebrew environment, ftpd, a working NDSP setup,
Bun, yt-dlp and FFmpeg on the Mac, Docker, and the Rust toolchain requested by
the vendored PocketJS build. MVD decoding requires New 3DS hardware. Unsupported
hardware produces a visible playback error.

Before first playback, press **L + D-pad Down + SELECT** to open Luma3DS
Rosalina, then choose **Miscellaneous options → Dump DSP firmware**. This
writes `/3ds/dspfirm.cdc` from the console's firmware. Without that file or a
Homebrew Launcher DSP handle, NDSP returns `0xd880a7fa` and playback stops at
audio initialization. After dumping the firmware, return to the player and
choose Retry. See the [devkitPro audio setup](https://github.com/devkitPro/3ds-examples/blob/master/audio/README.md).

```sh
bun run setup
bun run 3ds
# While ftpd is open; use the IP and port shown on its screen:
bun run deploy:3ds --host 192.168.8.102 --ftp-port 5000
# Launch /3ds/pocket-youtube.3dsx in the Homebrew Launcher, then:
bun run serve:3ds --device 192.168.8.102
```

The installer preserves an existing application pairing key, backs up a
previous launcher, and reads back the uploaded binary. Its receipt is
`.pocket/last-deploy-3ds.json`. It does not replace another app's key or the
device-wide Runtime key. `--advertise <Mac IPv4>` selects the media interface
when the Mac has several networks. The device and Mac need access to each
other on the LAN. The companion uses authenticated port 8741 for commands
and a ticketed TCP endpoint for media.

`bun run 3ds --cia` also builds an installable CIA. A native ABI change requires
reinstalling the launcher; a guest package alone cannot install a decoder.

## Execution and bandwidth

| Work | Owner |
| --- | --- |
| YouTube search, TLS, format resolution | Companion worker, shared yt-dlp adapter |
| Scaling, H.264 rate control, audio encoding | Companion FFmpeg and block encoder |
| H.264 decode and RGB565 conversion | New 3DS MVD service |
| Texture scaling and presentation | PICA200 |
| Audio output and playback clock | NDSP |
| Input, progress preview, pause and volume | Device guest/native handoff |

The stream uses **512×256 baseline H.264 at 30 fps**, 650 kbps target video
rate, 750 kbps maximum rate, no B-frames, and a one-second keyframe interval.
Source aspect ratio is fitted to the 400×240 display before encoding. Stereo
22.05 kHz ADPCM uses about 177 kbps. A three-second moving test pattern measured
**856,723 bit/s including packet headers**, with 90 decodable video frames.
That is a software fixture measurement; it does not establish real Wi-Fi or
physical playback performance.

The paired offload channel carries bounded metadata and asynchronous job
polls. Media bytes never enter JSON. Eight consumer credits, fixed native
queues, and a 300 ms audio prebuffer bound queued work. Disconnect closes the
old stream. After a new authenticated session, the app resolves a fresh source
and resumes its selected video at the remembered position.

Result cards are worker-rendered in bounded coverage strips, preserving CJK
titles on baked-font devices. Thumbnails are monochrome on this transport.
PSP and Vita retain their existing color-card and stream adapters.

## Capability ownership and validation

The independent control screen is selected by `display.auxiliary`,
`input.touch.auxiliary` and `media.playback`. Application UI code does not call
MVD, NDSP or device SDK functions. Shared store actions, source resolution,
search, card text rasterization and scrubber state serve both presentations.
`pocket.3ds.json` declares native screen geometry; `pocket.json` retains the
480×272 PSP/Vita presentation.

PocketJS owns native media playback, ticketed streaming, the bounded audio
format, surface-aware keyboards, and auxiliary WASM rendering. YouTube search,
video selection, encoding policy and the lower-screen layout belong here.

```sh
bun run typecheck
bun run test
bun run test:3ds
bun run 3ds
```

The dual-screen test boots the real application bundle, drives lower-screen
keyboard input and controls, verifies one-seek-per-drag and reconnect, and
writes software renders into `out/dual-screen/`. Its media host is a test
double. **Physical decoding, sustained frame rate, audio sync, network recovery
and touch acceptance require a separate device receipt.** The companion logs
decoder, presentation, buffer, byte and underrun counters every two seconds.
