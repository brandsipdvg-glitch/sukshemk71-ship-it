/**
 * SoundShare — FSK Decoder
 * ---------------------------------------------------------------------------
 * Turns raw microphone PCM into text messages.
 *
 * DSP pipeline (everything is sample-accurate; frame timing is derived from
 * the sample count, never from wall-clock or UI timers):
 *
 *   1. Microphone PCM is buffered in-order (fed by js/audio.js).
 *   2. The stream is split into 25 ms tiles ("frames").
 *   3. For every frame a Hann-windowed Goertzel filter measures the energy in
 *      the 1000 Hz band and the 2000 Hz band.
 *   4. A "soft" metric s = (E2000 - E1000) / (E2000 + E1000) is produced for
 *      each frame: +1 ⇒ "1" (2000 Hz dominant), -1 ⇒ "0" (1000 Hz dominant).
 *   5. A matched filter scans the soft stream for the 48-bit preamble
 *      (4 frames per symbol → 192-frame search window, 4 phase hypotheses)
 *      to find the exact symbol-grid alignment.
 *   6. Once aligned, symbols are read (4 frames each), the length field is
 *      decoded, then payload + CRC32 + end marker.
 *   7. CRC32 is verified: on success the text is delivered via onMessage,
 *      on failure onError is fired and the receiver re-locks on the next
 *      preamble.
 *
 * Constructor handlers:
 *   onSync(meta)            — preamble detected, decoding started
 *   onMessage(text, meta)   — valid packet decoded and verified
 *   onError(reason)         — packet invalid (bad length/CRC/marker)
 *   onDebug(debug)          — called every frame for the debug panel
 *
 * Public API:
 *   setSampleRate(fs)
 *   processSamples(chunk: Float32Array)
 *   reset()
 *   getDebug()
 */

(function () {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;
  const SS = (root.SS = root.SS || {});
  const P = SS.Protocol || {};

  /* Analysis frame length == one quarter symbol (25 ms). */
  const FRAME_SECONDS = 0.025;
  /* Four tiles per symbol, so 4 * 48 = 192 frames cover the preamble. */
  const FRAMES_PER_SYMBOL = 4;
  const SEARCH_SYMBOLS = P.PREAMBLE_BITS || 48;
  const SEARCH_WINDOW = SEARCH_SYMBOLS * FRAMES_PER_SYMBOL; /* 192 frames */

  /* Matched-filter acquisition thresholds (tunable). */
  const ACQ_SCORE_FULL = 0.65;  /* full 48-symbol correlation            */
  const ACQ_SCORE_HIGH = 0.85;  /* near-perfect lock — bypasses the guard */
  const ACQ_SCORE_SYNC = 0.6;   /* 16-bit sync-tail correlation          */
  const ACQ_ABS_MIN = 0.18;     /* average |symbol soft| (signal present) */
  const ACQ_GUARD_FRAMES = 12;  /* frames checked just before the start  */
  const ACQ_GUARD_MAX = 0.3;    /* max avg |soft| allowed in the guard   */

  /* If a locked packet goes silent for more than this many consecutive frames,
   the real transmission has ended. Abandon the lock (even if the decoded
   length implied a longer packet) so the receiver resumes searching instead of
   sitting in "Decoding" for up to several minutes. */
  const SYNC_QUIET_FRAMES = 20; /* ≈ 0.5 s of quiet */
  const SYNC_QUIET_ABS = 0.15;  /* |soft| below this counts as quiet        */

  const LENGTH_BITS = P.LENGTH_FIELD_BITS || 16;
  const CRC_BITS = P.CRC_BITS || 32;
  const END_MARKER_BITS = 16;

  class FskDecoder {
    /**
     * @param {object} handlers - callbacks (onSync/onMessage/onError/onDebug)
     * @param {number} [options.sampleRate] - audio sample rate (Hz)
     */
    constructor(handlers, options = {}) {
      this.handlers = handlers || {};
      this.sampleRate = 0;
      this._configured = false;
      if (options.sampleRate) this.setSampleRate(options.sampleRate);
      this.reset();
    }

    /* ------------------------------------------------------------ */
    /* Input stage                                                   */
    /* ------------------------------------------------------------ */

    /**
     * (Re)builds every sample-rate-dependent quantity: analysis tile length,
     * Goertzel bin indices (tone frequencies are exact integer bins because
     * an integer number of cycles fits in 25 ms) and the Hann window.
     * @param {number} fs - context sample rate in Hz
     */
    setSampleRate(fs) {
      if (fs === this.sampleRate && this._configured) return;
      this.sampleRate = fs;

      /* 25 ms of audio in samples, e.g. 1102 @ 44.1 kHz. */
      this.frameN = Math.round(fs * FRAME_SECONDS);

      /* Goertzel "bin number" for the two tone frequencies. Because the
         analysis window is exactly 25 ms, a 1000 Hz tone completes exactly
         25 cycles and a 2000 Hz tone exactly 50 cycles, so k is always an
         exact integer regardless of the device sample rate. */
      this._kZero = Math.round((P.FREQ_ZERO * this.frameN) / fs);
      this._kOne = Math.round((P.FREQ_ONE * this.frameN) / fs);

      /* Hann window of length frameN, cached and reused every frame. */
      this._hann = new Float32Array(this.frameN);
      for (let i = 0; i < this.frameN; i++) {
        this._hann[i] =
          0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.frameN - 1 || 1)));
      }

      /* Preamble correlation pattern: +1 for "2000 Hz bit 1", -1 for "1000 Hz
         bit 0", derived from the same preamble the encoder transmits. */
      const pb = (P.preambleBits) ? P.preambleBits : [];
      this._pattern = new Float32Array(pb.length);
      for (let k = 0; k < pb.length; k++) {
        this._pattern[k] = pb[k] ? 1 : -1;
      }
      this._syncStart = P.ALT_BITS || 32; /* index where the sync word starts */

      /* One symbol contains SYMBOL_SECONDS / FRAME_SECONDS = ~4.004 frames
         (e.g. 4410 / 1102 @ 44.1 kHz). This residual is exactly why we must
         position symbols by sample-time run-length, not by a fixed count of
         4 frames: over a long packet the fractional frame per symbol would
         otherwise drift the grid out of alignment. */
      this._symbolN = Math.round(fs * (P.SYMBOL_SECONDS || 0.1));
      this._ratio = this._symbolN / this.frameN;

      this._configured = true;
    }

    /**
     * Feeds a chunk of raw mono PCM samples (Float32Array in [-1, 1]) into
     * the decoder. Audio callback cadence may be irregular — the decoder only
     * cares about the total sample count, so timing stays sample-accurate.
     * @param {Float32Array} chunk
     */
    processSamples(chunk) {
      if (!this._configured || !this.sampleRate) {
        throw new Error("FskDecoder: setSampleRate() must be called first.");
      }
      for (let i = 0; i < chunk.length; i++) this._buf.push(chunk[i]);
      this._pushed += chunk.length;
      this._drain();
    }

    /**
     * Emits as many 25 ms analysis frames as the buffered sample count
     * permits, in strict order, then discards consumed samples.
     */
    _drain() {
      while (this._buf.length >= this.frameN) {
        const tile = this._buf.splice(0, this.frameN);
        this._frames += 1;
        this._analyze(tile);
      }
    }

    /* ------------------------------------------------------------ */
    /* Per-frame spectral analysis                                   */
    /* ------------------------------------------------------------ */

    /**
     * Runs the Goertzel filter for one frequency bin over a (Hann-windowed)
     * tile and returns an energy-ish magnitude.
     * @param {number[]} tile - frameN PCM samples
     * @param {number} k - Goertzel bin index (see setSampleRate)
     * @returns {number} squared magnitude in that bin
     */
    _goertzel(tile, k) {
      const n = tile.length;
      const w = (2 * Math.PI * k) / n;
      const coef = 2 * Math.cos(w);
      const hann = this._hann;
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        const x = tile[i] * hann[i];
        s0 = x + coef * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const re = s1 - s2 * Math.cos(w);
      const im = s2 * Math.sin(w);
      return re * re + im * im;
    }

    /**
     * Rough instantaneous frequency estimate via zero-crossing counting;
     * used only for the debug panel (not for demodulation).
     * @param {number[]} tile - frameN PCM samples
     * @returns {number} apparent Hz
     */
    _zeroCrossHz(tile) {
      let crossings = 0;
      for (let i = 1; i < tile.length; i++) {
        if ((tile[i - 1] < 0 && tile[i] >= 0) || (tile[i - 1] >= 0 && tile[i] < 0)) {
          crossings++;
        }
      }
      const seconds = tile.length / this.sampleRate;
      return Math.round(crossings / (2 * seconds));
    }

    /**
     * Analyzes one 25 ms tile: compute band energies, derive the "soft" metric
     * in [-1, 1], maintain sliding 4-frame sums, then attempt detection.
     * @param {number[]} tile
     */
    _analyze(tile) {
      const eZero = this._goertzel(tile, this._kZero);
      const eOne = this._goertzel(tile, this._kOne);
      const aZero = Math.sqrt(eZero);
      const aOne = Math.sqrt(eOne);
      const total = aZero + aOne;

      /* Normalised band imbalance: +1 = pure 2000 Hz, -1 = pure 1000 Hz,
         0 = silence or balance between the bands. */
      const soft = total > 1e-12 ? (aOne - aZero) / total : 0;
      this._soft.push(soft);

      this._lastSoft = soft;
      this._measuredHz = this._zeroCrossHz(tile);
      this._toneHz = Math.round(
        (soft + 1) / 2 * (P.FREQ_ONE - P.FREQ_ZERO) + P.FREQ_ZERO
      );

      if (!this.synced) this._scanPreamble();
      else this._decodeStep();

      this.handlers.onDebug && this.handlers.onDebug(this.getDebug());
    }

    /* ------------------------------------------------------------ */
    /* Acquisition — preamble matched filter                          */
    /* ------------------------------------------------------------ */

    /**
     * Scans for the preamble. Because the transmitter may start any time
     * relative to our 25 ms hop grid, we test the 4 phase hypotheses closest
     * to the end of the soft buffer; as new frames stream in, the correct
     * hypothesis is the one that maximises correlation with the known 48-bit
     * preamble pattern. A valid lock needs:
     *   full-pattern correlation ≥ 0.5,
     *   sync-tail correlation   ≥ 0.25,
     *   average |symbol|        ≥ 0.18  (real signal, not noise).
     */
    _scanPreamble() {
      const L = this._soft.length;
      if (L < SEARCH_WINDOW) return;

      let bestS = -1;
      let bestScore = -Infinity;

      for (let phase = 0; phase < FRAMES_PER_SYMBOL; phase++) {
        const s = L - SEARCH_WINDOW + phase; /* candidate grid start */
        if (s < 0) continue;

        let score = 0, sync = 0, absSum = 0, nan = false;
        for (let k = 0; k < SEARCH_SYMBOLS; k++) {
          const v = this._symbolSoftAt(s, k); /* one symbol's soft value */
          if (Number.isNaN(v)) { nan = true; break; } /* not buffered yet */
          const m = this._pattern[k];
          score += v * m;
          if (k >= this._syncStart) sync += v * m;
          absSum += Math.abs(v);
        }
        if (nan) continue; /* candidate incomplete — evaluate on a later frame */
        score /= SEARCH_SYMBOLS;
        sync /= SEARCH_SYMBOLS - this._syncStart;
        absSum /= SEARCH_SYMBOLS;

        /* Quiet guard: the 12 frames just before the candidate must be quiet.
           This rejects half-window matches of the alternating preamble that
           only overlap one symbol of gap but sit inside the real tone train. */
        let guardSum = 0, guardCount = 0;
        for (let g = Math.max(0, s - ACQ_GUARD_FRAMES); g < s; g++) {
          guardSum += Math.abs(this._soft[g]);
          guardCount++;
        }
        const guard = guardCount ? guardSum / guardCount : 0;

        if (score > bestScore) {
          bestScore = score;
          bestS = s;
          this._score = score;
          this._scoreSync = sync;
          this._absAvg = absSum;
          this._guard = guard;
        }
      }

      if (
        bestS >= 0 &&
        bestScore >= ACQ_SCORE_FULL &&
        this._absAvg >= ACQ_ABS_MIN &&
        this._scoreSync >= ACQ_SCORE_SYNC &&
        (this._guard <= ACQ_GUARD_MAX || bestScore >= ACQ_SCORE_HIGH)
      ) {
        this.synced = true;
        this.startIndex = bestS;
        this.state = "synced";
        this.symbolIndex = 0;
        this.handlers.onSync &&
          this.handlers.onSync({ score: bestScore, startIndex: bestS });
      }
    }

    /* ------------------------------------------------------------ */
    /* Decoding — packet assembly and verification                    */
    /* ------------------------------------------------------------ */

    /**
     * Number of frames that cover symbols 0..kLast (inclusive), measured from
     * the packet's first frame. Uses sample-time run-length positioning so the
     * fractional frame per symbol (≈4.004) never accumulates into drift.
     * @param {number} kLast - last symbol index
     * @returns {number} number of frames needed
     */
    _framesForSymbols(kLast) {
      /* A frame participates in symbol k when its centre sample lies inside the
         symbol's nominal span [S·H + k·N, S·H + (k+1)·N). Solving for d (frame
         offset from packet start): ceil(k·r − 0.5) ≤ d ≤ floor((k+1)·r − 0.5),
         where r = symbols-to-frames ratio (N/H). */
      const d = Math.floor((kLast + 1) * this._ratio - 0.5);
      return d + 1; /* d is the max offset, so d+1 frames cover symbol kLast */
    }

    /**
     * Returns the decoded soft value for a symbol: the average of the soft
     * values of every frame whose centre lies inside the symbol's time span.
     * Returns NaN if the symbol is not fully buffered yet.
     * @param {number} k - symbol index counted from packet start
     * @returns {number} soft value in [-1, 1] (or NaN)
     */
    _symbolSoft(k) {
      return this._symbolSoftAt(this.startIndex, k);
    }

    /**
     * Symbol soft value evaluated against an arbitrary candidate packet base
     * frame (used both for the final reads and for the preamble scan).
     * @param {number} base - frame index of packet start (candidate)
     * @param {number} k - symbol index counted from packet start
     * @returns {number} soft value in [-1, 1] (or NaN if unbuffered)
     */
    _symbolSoftAt(base, k) {
      const r = this._ratio;
      const d0 = Math.ceil(k * r - 0.5);
      const d1 = Math.floor((k + 1) * r - 0.5);
      let sum = 0, count = 0;
      for (let d = d0; d <= d1; d++) {
        const i = base + d;
        if (i >= this._soft.length) return NaN; /* not buffered yet */
        sum += this._soft[i];
        count++;
      }
      return count ? sum / count : 0;
    }

    /**
     * Reads `count` bits (soft values, sign-thresholded) starting at symbol
     * `startK`, assembling them MSB first into an integer.
     * @param {number} startK
     * @param {number} count
     * @returns {number|null} value, or null if data not yet available
     */
    _readBits(startK, count) {
      const neededFrames = this._framesForSymbols(startK + count - 1);
      if (this._soft.length < this.startIndex + neededFrames) return null;
      let value = 0;
      for (let j = 0; j < count; j++) {
        const v = this._symbolSoft(startK + j);
        if (Number.isNaN(v)) return null;
        value = (value << 1) | (v > 0 ? 1 : 0);
      }
      /* Normalise to an unsigned 32-bit value (JS bitwise ops are signed). */
      return value >>> 0;
    }

    /**
     * Advances decoding while a packet lock is held. Reads the length field
     * as soon as possible, waits for the full payload, then validates CRC32
     * and end marker and reports the outcome.
     */
    _decodeStep() {
      const L = this._soft.length;
      const S = this.startIndex;

      /* Phase 1: decode the 16-bit message-length field. */
      if (!this.lengthKnown) {
        const len = this._readBits(SEARCH_SYMBOLS, LENGTH_BITS);
        if (len === null) return;

        this.payloadLen = len;
        this.lengthKnown = true;

        if (len < 1) {
          this._fail("Decoded zero-length message.");
          return;
        }
        if (len > P.MAX_PAYLOAD_BYTES) {
          this._fail("Implausible message length (" + len + " bytes).");
          return;
        }

        this._totalSymbols =
          SEARCH_SYMBOLS + LENGTH_BITS + len * 8 + CRC_BITS + END_MARKER_BITS;
      }

      /* Preamble (48) + length (16) + payload (8·N) + CRC (32) + marker (16). */
      const totalSymbols =
        this.lengthKnown
          ? this._totalSymbols
          : SEARCH_SYMBOLS + LENGTH_BITS + CRC_BITS + END_MARKER_BITS + 8;

      /* Progress display only: how many symbols are currently available. */
      const framesAvail = Math.max(0, L - S);
      this.symbolIndex = Math.max(
        0, Math.min(totalSymbols, Math.floor(framesAvail / this._ratio)));

      /* Wait until the whole packet is buffered (sample-accurate length). */
      const needsFrames = this._framesForSymbols(totalSymbols - 1);

      /* Quiet-continuation watchdog: if the last ~0.5 s of audio went silent
         while we are still waiting, the real transmission has already ended
         (e.g. the decoded length was corrupted to far more than reality).
         Abandon the lock so a real later transmission is not missed. */
      if (L - S < needsFrames && this._tailQuiet(SYNC_QUIET_FRAMES)) {
        this._fail("Transmission went silent — resynchronizing.");
        return;
      }

      if (L < S + needsFrames) return;

      const len = this.payloadLen;

      /* Payload bytes. */
      const payload = new Uint8Array(len);
      for (let b = 0; b < len; b++) {
        const value = this._readBits(SEARCH_SYMBOLS + LENGTH_BITS + b * 8, 8);
        payload[b] = value;
      }

      /* CRC-32 received over the air. */
      const crcReceived = this._readBits(
        SEARCH_SYMBOLS + LENGTH_BITS + len * 8, CRC_BITS);

      /* End marker received over the air. */
      const markerReceived = this._readBits(
        SEARCH_SYMBOLS + LENGTH_BITS + len * 8 + CRC_BITS, END_MARKER_BITS);

      /* Recompute the expected CRC over [len_hi, len_lo, ...payload]. */
      const crcInput = new Uint8Array(2 + len);
      crcInput[0] = (len >>> 8) & 0xff;
      crcInput[1] = len & 0xff;
      crcInput.set(payload, 2);
      const crcExpected = SS.CRC32.crc32(crcInput);

      this._crc = { received: crcReceived, expected: crcExpected };

      if (crcReceived === crcExpected && markerReceived === P.END_MARKER) {
        let text = null;
        try {
          text = new TextDecoder("utf-8").decode(payload);
        } catch (e) {
          text = null;
        }
        if (text === null) {
          this._fail("Payload was not valid UTF-8 text.");
          return;
        }
        this.state = "complete";
        this.handlers.onMessage &&
          this.handlers.onMessage(text, {
            bytes: len,
            totalBits: this._totalSymbols,
            crcOk: true,
          });
        this._resetForNextPacket();
      } else if (crcReceived !== crcExpected) {
        this._fail("CRC32 mismatch — transmission failed verification (got " +
          crcReceived.toString(16) + ", expected " +
          crcExpected.toString(16) + ").");
      } else {
        this._fail("End marker mismatch — packet framing was corrupted.");
      }
    }

    /**
     * True when the most recent `count` frames of soft history are all quiet
     * (|soft| below SYNC_QUIET_ABS) — used to detect that the transmission
     * has actually ended while a (possibly over-long) packet is still "open".
     * @param {number} count
     * @returns {boolean}
     */
    _tailQuiet(count) {
      const L = this._soft.length;
      const from = Math.max(0, L - count);
      for (let i = from; i < L; i++) {
        if (Math.abs(this._soft[i]) >= SYNC_QUIET_ABS) return false;
      }
      return true;
    }

    /**
     * Reports a decoding failure and immediately re-arms acquisition.
     * @param {string} reason
     */
    _fail(reason) {
      this._lastError = reason;
      this.state = "error";
      this.handlers.onError && this.handlers.onError(reason);
      this._resetForNextPacket();
    }

    /**
     * Drops everything but a short tail of recent soft history so the next
     * transmission's preamble can be re-acquired while we keep listening.
     */
    _resetForNextPacket() {
      const tail = SEARCH_WINDOW + 64;
      if (this._soft.length > tail) this._soft = this._soft.slice(-tail);
      this.synced = false;
      this.startIndex = -1;
      this.lengthKnown = false;
      this.payloadLen = 0;
      this._totalSymbols = 0;
      this.state = "searching";
      this.symbolIndex = 0;
      this._lastError = null;
    }

    /**
     * Full decoder reset (also clears buffered PCM). Called by Stop.
     */
    reset() {
      this._buf = [];
      this._pushed = 0;
      this._frames = 0;
      this._soft = [];
      this._lastSoft = 0;
      this._measuredHz = 0;
      this._toneHz = 0;
      this._score = 0;
      this._scoreSync = 0;
      this._absAvg = 0;
      this._guard = 1;
      this._crc = null;
      this._lastError = null;
      this._totalSymbols = 0;
      this.synced = false;
      this.startIndex = -1;
      this.lengthKnown = false;
      this.payloadLen = 0;
      this.state = "searching";
      this.symbolIndex = 0;
    }

    /* ------------------------------------------------------------ */
    /* Debug                                                          */
    /* ------------------------------------------------------------ */

    /**
     * Snapshot of internal state for the debug panels.
     * @returns {object} human-readable debugging information
     */
    getDebug() {
      const totalSymbols = this._totalSymbols || 0;
      const packetBits = totalSymbols;
      return {
        state: this.state,
        measuredHz: Math.round(this._measuredHz),
        toneHz: Math.round(this._toneHz),
        lastSoft: Number(this._lastSoft.toFixed(3)),
        lastBit: this._lastSoft > 0 ? 1 : this._lastSoft < -0.15 ? 0 : null,
        frameIndex: this._frames,
        symbolIndex: this.synced ? this.symbolIndex : 0,
        totalSymbols: totalSymbols,
        bitProgress: this.synced
          ? Math.min(packetBits, this.symbolIndex) + " / " + packetBits
          : "—",
        payloadLen: this.lengthKnown ? this.payloadLen : null,
        score: Number(this._score.toFixed(3)),
        scoreSync: Number(this._scoreSync.toFixed(3)),
        lastError: this._lastError,
      };
    }
  }

  SS.Decoder = FskDecoder;
  SS.DecoderConstants = {
    FRAME_SECONDS,
    FRAMES_PER_SYMBOL,
    SEARCH_WINDOW,
    ACQ_SCORE_FULL,
    ACQ_SCORE_SYNC,
    ACQ_ABS_MIN,
  };
})();