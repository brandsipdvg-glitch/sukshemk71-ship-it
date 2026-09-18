# SoundShare 🔊

A **browser-based acoustic data transfer** app. It moves text between devices
using **only sound** — a speaker on one device and a microphone on another.
There is **no network of any kind**: no WebSocket, no Bluetooth, no Wi-Fi,
no QR code, and no relay server. The audio itself is the data link.

> **Phase 1 scope:** text only. Works 100% offline after loading. Static site,
> ready to deploy to GitHub Pages.

---

## Live protocol summary

| Parameter           | Value                              |
| ------------------- | ---------------------------------- |
| Modulation          | FSK (Frequency Shift Keying)       |
| Bit 0               | 1000 Hz sine tone                  |
| Bit 1               | 2000 Hz sine tone                  |
| Symbol duration     | 100 ms (≈ 10 bits/s)               |
| Framing             | Preamble · Length · Payload · CRC32 · End marker |
| Checksum            | CRC-32 (IEEE 802.3)                |
| Channel codec       | UTF-8, big-endian fields, MSB-first |

The rate is intentionally slow (10 bits/s) in favour of **reliability and
simplicity**. A short message like *"Hello World"* takes ~20 seconds over the
air.

---

## The packet format

Every transmission is a single packet:

```
|  PREAMBLE  | MESSAGE_LENGTH |  PAYLOAD  |   CRC32   | END_MARKER |
|  48 bits   |    16 bits     |   8·N bits |  32 bits  |  16 bits   |
```

| Field           | Size | Description                                                            |
| --------------- | ---- | ---------------------------------------------------------------------- |
| **Preamble**    | 48   | 32 alternating bits (`1010…`) followed by the 16-bit sync word `0x5AA5`. The alternating part gives the receiver a dense edge train to lock its symbol clock; the sync word confirms the alignment. |
| **Message length** | 16 | Payload byte count, big-endian (max 65 535 — the app caps at 2048). |
| **Payload**      | 8·N  | UTF-8-encoded message bytes, each byte MSB-first.                      |
| **CRC32**        | 32   | CRC-32 of `[length_hi, length_lo, …payload]`. Any bit error ends the packet. |
| **End marker**   | 16   | Fixed `0xA55A`. Independent timing check that the packet truly ended.  |

Example on-the-wire bit budget for *"Hello World"* (11 bytes):
48 + 16 + 88 + 32 + 16 = **200 symbols = 20 seconds**.

---

## Why it's reliable: the receive chain

The receiver (`js/decoder.js`) is a small software-defined radio:

1. **Capture** — the microphone is read through a `ScriptProcessorNode` on the
   native audio thread. Raw PCM frames stream into the decoder
   (`js/audio.js`).
2. **Spectral analysis** — the sample stream is cut into **25 ms tiles**.
   For every tile a **Hann-windowed Goertzel filter** measures the energy in
   the 1000 Hz and 2000 Hz bands, producing a normalised *soft* value
   `s = (E₂₀₀₀ − E₁₀₀₀)/(E₂₀₀₀ + E₁₀₀₀)` ∈ [−1, +1].
   Because a 100 ms symbol holds exactly 25 cycles of 1000 Hz and 50 cycles of
   2000 Hz, the Goertzel bins are exact integers at **any** device sample rate.
3. **Timing recovery** — symbols cover ~4.004 tiles, not exactly 4. The decoder
   therefore positions symbols by *sample-count run-length* rather than a fixed
   frame count, so the symbol grid never drifts even on long packets.
4. **Acquisition** — a matched filter correlates the soft stream against the
   48-bit preamble at the four possible 25 ms phase hypotheses. A lock requires:
   - full-preamble correlation ≥ 0.65,
   - sync-word correlation ≥ 0.6,
   - a **quiet guard** (the 12 tiles before the candidate must be near-zero),
     which is what rejects half-window false matches of the alternating train.
   A near-perfect lock (correlation ≥ 0.85) bypasses the guard, so a new
   transmission that starts barely after the previous one still locks.
5. **Decoding** — length, payload, CRC32 and end marker are read symbol by
   symbol. CRC-32 is recomputed and compared; the end marker must also match.
   If the tones go silent while a (possibly corrupted-length) packet is still
   open, a **quiet-continuation watchdog** bails out after ~0.5 s and the
   receiver resumes searching instead of waiting for minutes.
6. **Result** — valid packets are handed to the page as UTF-8 text; invalid
   packets raise a **transmission error** and the receiver keeps listening.

The receive page also runs a **capture health watchdog**: if no audio frames
arrive for ~3 s while listening (a browser/OS mic hiccup after sleep or a
device switch), it automatically restarts the receiver up to 3 times and logs
each recovery in the Recent log.

This chain is verified offline by `test/acoustic.test.js`: it synthesises the
actual FSK waveform for a packet, feeds it through the decoder, and asserts the
text round-trips — including under noise, mid-stream starts, 48 kHz, attenuated
tones, and forced bit corruption.

---

## Project structure

```
soundshare/
├── index.html            # Home screen: Send / Receive
├── send.html             # Compose text, transmit tones, live Tx debug
├── receive.html          # Listen, decode, live Rx debug + log
├── css/
│   └── style.css         # Shared dark "instrument panel" theme
├── js/
│   ├── crc.js            # CRC-32 (IEEE 802.3, table-driven)
│   ├── encoder.js        # text -> UTF-8 -> bits -> packet bits (SS.Encoder)
│   ├── decoder.js        # FSK demodulator + packet decoder (SS.Decoder)
│   └── audio.js          # Web Audio TX scheduler + mic RX capture
└── test/
    └── acoustic.test.js  # Offline round-trip tests (node test/acoustic.test.js)
```

`js/*` are plain classic scripts sharing a global `window.SS` namespace (no
build step, no ES modules) so the site works even when opened straight from
`file://`.

---

## Run it locally

Microphone access requires a **secure context**. Either serve over `localhost`
or use HTTPS (GitHub Pages provides both).

```bash
# Option A — Python
python3 -m http.server 8080
# open http://localhost:8080

# Option B — Node
npx serve .
# open the printed URL

# Option C — just open index.html (works for browsing; getUserMedia still needs
# localhost or HTTPS in Chrome, so prefer A or B for the live demo)
```

### Offline test suite (no browser needed)

```bash
node test/acoustic.test.js
```

---

## Deploy to GitHub Pages

1. Create a repository with these files (e.g. push this folder as-is).
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select branch `main` (or `master`), folder `/ (root)`, and **Save**.
5. Your site is live at `https://<user>.github.io/<repo>/`.

No build tools, no actions config, no backend — it's plain static HTML/CSS/JS.

---

## Success test (the spec's acceptance flow)

1. Open the **Send** page on Device A.
2. Type `Hello World`.
3. Press **Send** — Device A's speaker emits the tone sequence
   (status: *Encoding → Transmitting → Transmission complete*).
4. Open the **Receive** page on Device B. Press **Start Listening**
   (status: *Listening*).
5. Keep B's microphone within ~1 m of A's speaker; avoid keyboard noise.
6. When the preamble is detected the status flips to *Decoding* and the symbol
   progress bar advances.
7. On success the status shows *Message received*, `Hello World` appears in the
   text box, and the log line confirms *CRC32 verified*.

The **receiver debug panel** shows the live detected frequency, the last decoded
bit, packet progress, preamble score and payload length — handy when tuning
volume or distance.

---

## Troubleshooting

- **Microphone permission denied / button does nothing** — the page must run on
  `localhost` or HTTPS. Allow mic access in the browser prompt.
- **Received message shows an error (CRC / length)** — reduce distance, raise
  send volume, silence room noise, or keep the device still while listening.
  Speakers vibrate; the desk coupling can smear tones.
- **Echo or feedback on one device** — receive pages capture the mic but their
  output is muted; keep the send device un-muted by design.
- **Echo cancellation must stay off** — SoundShare requests
  `echoCancellation / noiseSuppression / autoGainControl: false`, because those
  processors distort FSK tones. If a specific browser overrides this, move the
  transmitting speaker a little farther from the receiving mic.
- **No lock at all** — check the debug *Detected frequency*: it should jump
  between ≈1000 and ≈2000 Hz during a transmission. If it stays flat, the mic
  isn't hearing the tones. If *Input rate* reads 0 f/s, the microphone graph has
  stalled — the page tries to restart it automatically; otherwise press Stop
  then Start.
- **Back-to-back packets** — the quiet-guard acquisition prefers a short gap of
  silence before each transmission, but packets sent barely after the previous
  one (< 0.3 s) still lock thanks to the high-confidence bypass.

---

## Design choices & roadmap

- **Goertzel over FFT** — Goertzel needs only two frequency bins, is cheaper and
  simpler to reason about than a full FFT.
- **ScriptProcessorNode over AudioWorklet** — `createScriptProcessor` works on
  `file://` and every browser, and it captures on the audio thread so capture
  continues if the UI thread is busy. AudioWorklet is the long-term upgrade but
  needs module loading (which is unsupported from `file://`).
- **Text only (Phase 1)** — the protocol already carries arbitrary bytes, so
  Phase 2 (files) just adds a header flag for content type. The 100 ms symbol
  keeps Phase 1 readable; a future "fast mode" can shorten the symbol.

---

## License

MIT — do whatever you like, but it's sound-only: no network code anywhere.