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
the PocketJS system keyboard in its contact layout: 30-pixel-high keys on
phone-style staggered rows. This is an adaptation of those interaction
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
Each frame contains **one complete VCL slice**. The encoder uses one thread
and disables sliced threading; `slices=1` alone does not override the
zero-latency preset's thread-based splitting. That splitting caused MVD to
reject the second slice of the first frame with `0x17005` on hardware.
Source aspect ratio is fitted to the 400×240 display before encoding. Stereo
22.05 kHz ADPCM uses about 177 kbps. A three-second moving test pattern measured
**854,712 bit/s including packet headers**, with 90 decodable video frames.
That is a software fixture measurement; it does not establish real Wi-Fi or
physical playback performance.

The paired offload channel carries bounded metadata and asynchronous job
polls. Media bytes never enter JSON. Eight consumer credits, fixed native
queues, and a 300 ms audio prebuffer bound queued work. Disconnect closes the
old stream. After a new authenticated session, the app resolves a fresh source
and resumes its selected video at the remembered position.

The lower screen uses baked silver navigation chrome, a fine gray texture,
beveled transport buttons, white result rows and the framework keyboard's
classic theme. Official
YouTube vector outlines are rasterized without changing their aspect ratio;
`artwork/youtube/README.md` records their source and `bun run bake:classic`
reproduces the assets.

An empty list shows a recessed search card with a touch action and an X-key
hint. The card changes its title and description while connecting, searching,
or displaying an empty result. **Touching the card opens the search keyboard.**

**Titles do not wait for thumbnail downloads.** Each title and channel uses
one 192×36 coverage response, preserving CJK text on baked-font devices. Each
72×40 color thumbnail uses one 16-color indexed response. Both fit the 2,500-byte
offload payload bound. Two worker downloads run at once; image decoding uses
the companion's canvas library without spawning FFmpeg per thumbnail.

The existing PocketJS resource runtime owns a 1.5 MiB texture cache, up to
32 entries, two active reads, one read start and one materialization per frame.
Visible titles have priority over thumbnails and adjacent-row prefetch. A row
that unmounts withdraws demand; its ready texture remains until cache eviction.
Pending thumbnail polls back off from six to sixty frames. Playback commands
use the offload client outside the resource queue, with four tickets reserved.

Search pages follow Pocket Doc's query-and-offset resource identity. The
companion owns two bounded query snapshots and streams up to twenty search
results per fill. A page becomes readable after five rows arrive; requests for
the same page share the snapshot. The next fill retains prior row order and
removes duplicate video IDs. Failed fills do not advance the page position.

**Scrolling predicts page demand before the end of the list.** The app requests
one next page when three rows of base lookahead reach the loaded boundary;
downward velocity can add five rows of lookahead. Metadata uses the same
resource scheduler as artwork, ahead of thumbnail work. Reconnect clears page
state for the new companion session. No selectable pagination row is mounted.

The search keyboard is PocketJS's system keyboard (`@pocketjs/framework/osk`)
rendered on the auxiliary surface with the `classic` theme. **The surface
reports contacts, so the framework picks the staggered layout and the
down-edge press model**: a character types on the down edge, release clears
the pressed cap, backspace repeats while held, holding space drags the caret,
and a second shift press within 0.35 s locks caps. The d-pad focus ring stays
hidden until the first d-pad press. B cancels, START commits, L switches the
number layer and R shifts. The keyboard remembers its layer and key across
opens. Now Playing uses a baked arrow image rather than a Unicode icon outside
the device font's coverage.

PSP and Vita run the single-screen presentation with the same classic chrome:
glossy title bar, white host-rendered rows with a blue selection wash, and the
same keyboard in its grid layout for the d-pad. They retain their color-card
and stream adapters.

## Capability ownership and validation

One `pocket.json` describes every device. **Its `dual-screen` presentation
is addressed to the modality `{ "screens": 2, "touch": "auxiliary" }`**: the
resolver derives the 3DS profile's modality, selects that entry
(`app/main-dual.tsx`), resolves its 400×240 top and 320×240 auxiliary
viewports, and admits `display.auxiliary`, `input.touch.auxiliary`,
`media.playback` and `io.offload` on top of the app-level capabilities. The
PSP and Vita derive to one screen and compile the baseline `app/main.tsx`.
The compiler walks each bundle from its entry, so the 3DS artwork and the
PSP card code never share a bundle. Application UI code does not call MVD,
NDSP or device SDK functions. Shared store actions, source resolution,
search, card text rasterization and scrubber state serve both presentations
(`docs/MODALITY.md` in PocketJS states the model).

**One companion data layer serves both devices.** `host/companion-worker.ts`
answers search pages (`youtube.search`), artwork (`youtube.artwork`) and
playback commands over PocketJS offload. The 3DS reaches it over TCP
(`bun run serve:3ds`); the PSP reaches the same worker over the PSPLINK
share through the USB offload provider (`bun run serve:psp`), where video uses
the `.pkst` ring under `pocket-svc/youtube/`. Rows on both devices are
demand-driven resources requested for the list's visible window
(`ClassicList.onWindow`), so a d-pad walk to the end pages in without a
sentinel press.

PocketJS owns native media playback, ticketed streaming, the bounded audio
format, surface-aware keyboards, auxiliary WASM rendering, resource lifetime
and bounded indexed-image uploads. The **service client owns transport selection,
job polling, deadlines and reconnect**. The **media provider owns native pause,
ring control, end polling, stream files and the playback clock**. The app requests
artwork through the provider image loader. YouTube search,
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

The software journeys cover keyboard input, paging, playback, pause, seeking,
back navigation and reconnect. The user confirmed the preceding 0.3.0 build's
3DS acceptance on September 16. Provider refactoring has a separate software
validation receipt; that confirmation does not establish a new physical run.

The color correction selects `MVD_OUTPUT_BGR565`, the MVD output format used
by the devkitPro example for the GPU's RGB565 packing. MVD's `RGB565` selection
exchanged red and blue. The companion retains the source colors; a real H.264
encode/decode regression checks red, green, blue, yellow and a skin-tone patch.
Physical color and input acceptance are recorded after installing the new
native launcher.
