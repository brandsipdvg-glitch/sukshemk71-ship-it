/**
 * SoundShare — QuadDecoder ("Ultra" 4-FSK fast mode)
 * ---------------------------------------------------------------------------
 * The same software-defined-radio architecture as decoder.js (FskDecoder),
 * demodulating the 4-tone scheme that carries TWO bits per symbol:
 *
 *   quad 0 -> 1100 Hz   quad 1 -> 1800 Hz
 *   quad 2 -> 2500 Hz   quad 3 -> 3200 Hz
 *
 * One symbol is 15 ms. The analysis tile is 1/4 of a symbol (3.75 ms); the
 * sub-symbol phase hypotheses are scanned by the preamble matched filter.
 *
 * Timing is done in SAMPLE coordinates, not tile counts: a symbol spans
 * exactly symbolN samples, and its spectrum is a length-weighted average of
 * every tile it overlaps. That makes acquisition exact at ANY fractional grid
 * offset (the transmitter almost never starts on our tile grid), which is the
 * difference between a robust link and one that decodes only when the
 * alignment happens to be near-integer.
 *
 * On-the-air layout (each symbol = 2 bits):
 *   PREAMBLE       32 quads  (LFSR pattern, aperiodic)
 *   MESSAGE_LENGTH  8 quads  (16 bits, big-endian)
 *   PAYLOAD         4·N quads (8 bits per byte)
 *   CRC32          16 quads  (of [length_hi, length_lo, ...payload])
 *   END_MARKER      8 quads  (0xA55A)
 *
 * Exposes: SS.QuadDecoder
 */

(function () {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;
  const SS = root.SS = root.SS || {};
  const P = SS.Protocol || {};

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const QF_TONES = P.QUAD_TONES || [1100, 1800, 2500, 3200];
  const QF_NTONES = QF_TONES.length;                 /* 4                */
  const QF_SYMBOL_SECONDS = P.QUAD_SYMBOL_SECONDS || 0.015;
  const QF_FRAME_SECONDS = QF_SYMBOL_SECONDS / 4;    /* 3.75 ms tile     */
  const QF_FRAMES_PER_SYMBOL = 4;
  const QF_PHASES = 8;                               /* acquisition phases  */
  const QF_PREAMBLE = P.QUAD_PREAMBLE || [];
  const QF_PREAMBLE_SYMS = QF_PREAMBLE.length;
  const QF_SEARCH_WINDOW = QF_PREAMBLE_SYMS * QF_FRAMES_PER_SYMBOL;
  const QF_LENGTH_SYMS = 8;                          /* 16-bit length    */
  const QF_END_SYMS = 8;                             /* 16-bit end marker*/

  function toneBits() {
    return Math.round(Math.LOG2E * Math.log(QF_NTONES));
  }
  const QF_TONE_BITS = toneBits();                   /* 2 bits per symbol */

  const QF_CRC_BITS = P.QUAD_CRC_BITS || 32;
  const QF_CRC_SYMS = QF_CRC_BITS / QF_TONE_BITS;
  const QF_MAX_PAYLOAD = P.MAX_PAYLOAD_BYTES || 2048;

  /* Acquisition thresholds — tuned against the synthetic chain. Locks are
     accepted only at a genuinely well-aligned phase: a sub-optimal phase can
     score ~0.44 while the correctly aligned one scores ~0.62, and locking on
     the early mediocre candidate would misdecode data symbols. */
  const QF_SCORE_LOCK = 0.52;   /* full 32-symbol preamble correlation */
  const QF_SCORE_HIGH = 0.62;   /* near-perfect lock — bypasses guard  */
  const QF_ABS_MIN = 0.42;      /* mean per-tile max-soft (signal)     */
  const QF_GUARD_TILES = 12;    /* ~1 symbol of quiet before candidate */
  const QF_GUARD_MAX = 0.5;     /* max avg |soft| allowed in guard     */
  const QF_QUIET_ABS = 0.5;     /* tile with max-soft below this = quiet */
  const QF_QUIET_FRAMES = 80;   /* ~0.3 s of quiet -> abandon the lock  */

  /* ====================================================================== */
  /* QuadDecoder                                                             */
  /* ====================================================================== */

  class QuadDecoder {
    /**
     * @param {object} handlers - onSync/onMessage/onError/onDebug
     * @param {object} [options] - { sampleRate }
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

    setSampleRate(fs) {
      if (fs === this.sampleRate && this._configured) return;
      this.sampleRate = fs;

      this.frameN = Math.round(fs * QF_FRAME_SECONDS);

      this._kQuads = new Float32Array(QF_NTONES);
      for (let i = 0; i < QF_NTONES; i++) {
        this._kQuads[i] = Math.round((QF_TONES[i] * this.frameN) / fs);
      }

      this._hann = new Float32Array(this.frameN);
      for (let i = 0; i < this.frameN; i++) {
        this._hann[i] =
          0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.frameN - 1 || 1)));
      }

      this._symbolN = Math.round(fs * QF_SYMBOL_SECONDS);
      this._ratio = this._symbolN / this.frameN;

      this._configured = true;
    }

    processSamples(chunk) {
      if (!this._configured || !this.sampleRate) {
        throw new Error("QuadDecoder: setSampleRate() must be called first.");
      }
      for (let i = 0; i < chunk.length; i++) this._buf.push(chunk[i]);
      this._drain();
    }

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

    _zeroCrossHz(tile) {
      let crossings = 0;
      for (let i = 1; i < tile.length; i++) {
        if ((tile[i - 1] < 0 && tile[i] >= 0) ||
            (tile[i - 1] >= 0 && tile[i] < 0)) crossings++;
      }
      const seconds = tile.length / this.sampleRate;
      return Math.round(crossings / (2 * seconds));
    }

    /**
     * One tile -> normalised 4-bin amplitude vector `soft[i] = a_i / Σ a`.
     * For silence/white noise the vector is near-uniform (each ~0.25); a pure
     * tone concentrates energy in its bin (max-soft ~0.7+).
     */
    _analyze(tile) {
      const amps = new Float32Array(QF_NTONES);
      let sum = 0;
      for (let i = 0; i < QF_NTONES; i++) {
        amps[i] = Math.sqrt(this._goertzel(tile, this._kQuads[i]));
        sum += amps[i];
      }
      const soft = new Float32Array(QF_NTONES);
      let maxS = 0, maxBin = 0;
      for (let i = 0; i < QF_NTONES; i++) {
        soft[i] = sum > 1e-12 ? amps[i] / sum : 0.25;
        if (soft[i] > maxS) { maxS = soft[i]; maxBin = i; }
      }

      this._hist.push({ soft, maxS, maxBin });
      this._lastSoft = maxS;
      this._lastBin = maxBin;
      this._measuredHz = this._zeroCrossHz(tile);

      if (!this.synced) this._scanPreamble();
      else this._decodeStep();

      this.handlers.onDebug && this.handlers.onDebug(this.getDebug());
    }

    /* ------------------------------------------------------------ */
    /* Symbol reads (sample-time coordinates)                        */
    /* ------------------------------------------------------------ */

    /**
     * Mean 4-bin soft vector for symbol `k`, whose span is
     * [startSamples + k·symbolN, startSamples + (k+1)·symbolN). Every tile the
     * span overlaps contributes its soft vector weighted by the overlap length
     * (in samples), so the result is exact for any fractional grid offset.
     * @param {number} startSamples - packet start, in samples (may be fractional)
     * @param {number} k - symbol index counted from packet start
     * @returns {Float32Array|null} mean soft vector, or null if not buffered
     */
    _symSoftAt(startSamples, k) {
      const frameN = this.frameN;
      const symN = this._symbolN;
      const lo = startSamples + k * symN;
      const hi = lo + symN;
      const i0 = Math.floor(lo / frameN);
      const i1 = Math.floor((hi - 1) / frameN);
      if (i1 >= this._hist.length) return null;

      const out = new Float32Array(QF_NTONES);
      for (let i = i0; i <= i1; i++) {
        const ov = Math.min(hi, (i + 1) * frameN) - Math.max(lo, i * frameN);
        const e = this._hist[i];
        for (let j = 0; j < QF_NTONES; j++) out[j] += e.soft[j] * ov;
      }
      for (let j = 0; j < QF_NTONES; j++) out[j] /= symN;
      return out;
    }

    /**
     * Preamble-match contribution of one symbol: how strongly the observed
     * spectrum favours the expected preamble quad over the other three.
     */
    _preambleContrib(vec, expected) {
      let maxOther = -Infinity;
      for (let i = 0; i < QF_NTONES; i++) {
        if (i !== expected && vec[i] > maxOther) maxOther = vec[i];
      }
      return vec[expected] - (maxOther === -Infinity ? 0 : maxOther);
    }

    /* ------------------------------------------------------------ */
    /* Acquisition — preamble matched filter                         */
    /* ------------------------------------------------------------ */

    _scanPreamble() {
      const L = this._hist.length;
      if (L < QF_SEARCH_WINDOW) return;

      const frameN = this.frameN;
      const symN = this._symbolN;
      const spanSamples = QF_PREAMBLE_SYMS * symN;
      /* The preamble's end is placed near the current tail of the buffer; the
         QF_PHASES offsets step through a full symbol period so the true
         (fractional) phase is always within half a phase-step of a candidate.
         Candidates that reach past the buffered tail are skipped until more
         frames arrive (that just means the correct phase locks a frame late). */
      const base = (L - 1) * frameN - spanSamples;
      const phaseStep = symN / QF_PHASES;

      let bestScore = -Infinity;
      let bestS = 0;
      let bestGuard = Infinity;
      let bestAbs = -Infinity;

      for (let p = 0; p < QF_PHASES; p++) {
        const startSample = base - symN + p * phaseStep;
        if (startSample < 0) continue;

        let score = 0, absSum = 0, missing = false;
        for (let k = 0; k < QF_PREAMBLE_SYMS; k++) {
          const vec = this._symSoftAt(startSample, k);
          if (!vec) { missing = true; break; }
          score += this._preambleContrib(vec, QF_PREAMBLE[k]);
          absSum += vec[QF_PREAMBLE[k]];
        }
        if (missing) continue;
        score /= QF_PREAMBLE_SYMS;
        absSum /= QF_PREAMBLE_SYMS;

        /* Quiet guard over roughly one symbol before the candidate. */
        let guardSum = 0, guardCount = 0;
        const gLo = startSample - QF_GUARD_TILES * frameN;
        const i0 = Math.floor(gLo / frameN);
        const i1 = Math.floor((startSample - 1) / frameN);
        for (let i = Math.max(0, i0); i <= Math.min(i1, this._hist.length - 1); i++) {
          guardSum += this._hist[i].maxS;
          guardCount++;
        }
        const guard = guardCount ? guardSum / guardCount : Infinity;

        if (score > bestScore) {
          bestScore = score;
          bestS = startSample;
          bestGuard = guard;
          bestAbs = absSum;
        }
      }

      if (!isFinite(bestScore)) return;

      const guardOk = bestGuard <= QF_GUARD_MAX;
      if (
        bestScore >= QF_SCORE_LOCK &&
        bestAbs >= QF_ABS_MIN &&
        (guardOk || bestScore >= QF_SCORE_HIGH)
      ) {
        this.synced = true;
        this.startSamples = bestS;
        this.startIndex = Math.round(bestS / frameN);
        this.state = "synced";
        this.symbolIndex = 0;
        this._score = bestScore;
        this.handlers.onSync &&
          this.handlers.onSync({ score: bestScore, startSamples: bestS });
      } else {
        /* Keep a live reading for the debug panel even without a lock. */
        this._score = bestScore;
      }
    }

    /* ------------------------------------------------------------ */
    /* Decoding                                                       */
    /* ------------------------------------------------------------ */

    /**
     * Reads `count` quads starting at symbol `startK`, MSB-first, into a
     * number. Returns null while data is still buffering.
     */
    _readInt(startK, count) {
      const startSamples = this.startSamples;
      const neededSamples = startSamples + (startK + count) * this._symbolN;
      if (this._hist.length * this.frameN < neededSamples) return null;
      let value = 0;
      for (let j = 0; j < count; j++) {
        const vec = this._symSoftAt(startSamples, startK + j);
        if (!vec) return null;
        let q = -1, best = -Infinity;
        for (let i = 0; i < QF_NTONES; i++) {
          if (vec[i] > best) { best = vec[i]; q = i; }
        }
        value = value * QF_NTONES + q;
      }
      return value >>> 0;
    }

    _decodeStep() {
      const L = this._hist.length;
      const S = this.startSamples;
      const bufferedSamples = L * this.frameN;

      const totalSymbols = this._totalSymbols ||
        (QF_PREAMBLE_SYMS + QF_LENGTH_SYMS + QF_CRC_SYMS + QF_END_SYMS +
          (this.lengthKnown ? this.payloadLen * 8 / QF_TONE_BITS : 8));

      /* Progress display only. */
      const symbolsAvail = (bufferedSamples - S) / this._symbolN;
      this.symbolIndex = Math.max(
        0, Math.min(totalSymbols, Math.floor(symbolsAvail)));

      if (!this.lengthKnown) {
        const len = this._readInt(QF_PREAMBLE_SYMS, QF_LENGTH_SYMS);
        if (len === null) {
          if (this._tailQuiet(QF_QUIET_FRAMES)) {
            this._fail("Transmission went silent — resynchronizing.");
            return;
          }
          return;
        }
        this.payloadLen = len;
        this.lengthKnown = true;
        if (len < 1) { this._fail("Decoded zero-length message."); return; }
        if (len > QF_MAX_PAYLOAD) {
          this._fail("Implausible message length (" + len + " bytes).");
          return;
        }
        this._totalSymbols =
          QF_PREAMBLE_SYMS + QF_LENGTH_SYMS + len * 8 / QF_TONE_BITS +
          QF_CRC_SYMS + QF_END_SYMS;
      }

      /* Wait until the whole packet is buffered. */
      const neededSamples = S + totalSymbols * this._symbolN;
      if (bufferedSamples >= neededSamples) {
        const len = this.payloadLen;

        const payload = new Uint8Array(len);
        for (let b = 0; b < len; b++) {
          payload[b] = this._readInt(
            QF_PREAMBLE_SYMS + QF_LENGTH_SYMS + b * 8 / QF_TONE_BITS, 4);
        }

        const crcReceived = this._readInt(
          QF_PREAMBLE_SYMS + QF_LENGTH_SYMS + len * 8 / QF_TONE_BITS,
          QF_CRC_SYMS);
        const markerReceived = this._readInt(
          QF_PREAMBLE_SYMS + QF_LENGTH_SYMS + len * 8 / QF_TONE_BITS +
          QF_CRC_SYMS, QF_END_SYMS);

        const crcInput = new Uint8Array(2 + len);
        crcInput[0] = (len >>> 8) & 0xff;
        crcInput[1] = len & 0xff;
        crcInput.set(payload, 2);
        const crcExpected = SS.CRC32.crc32(crcInput);
        this._crc = { received: crcReceived, expected: crcExpected };

        if (crcReceived === crcExpected && markerReceived === P.END_MARKER) {
          let text = null;
          try { text = new TextDecoder("utf-8").decode(payload); }
          catch (e) { text = null; }
          if (text === null) {
            this._fail("Payload was not valid UTF-8 text.");
            return;
          }
          this.state = "complete";
          this.handlers.onMessage &&
            this.handlers.onMessage(text, {
              bytes: len,
              totalBits: this._totalSymbols * QF_TONE_BITS,
              totalSymbols: this._totalSymbols,
              mode: "fast",
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
      } else if (this._tailQuiet(QF_QUIET_FRAMES)) {
        this._fail("Transmission went silent — resynchronizing.");
      }
    }

    _tailQuiet(count) {
      const L = this._hist.length;
      const from = Math.max(0, L - count);
      for (let i = from; i < L; i++) {
        if (this._hist[i].maxS >= QF_QUIET_ABS) return false;
      }
      return true;
    }

    _fail(reason) {
      this._lastError = reason;
      this.state = "error";
      this.handlers.onError && this.handlers.onError(reason);
      this._resetForNextPacket();
    }

    _resetForNextPacket() {
      const tail = QF_SEARCH_WINDOW + 64;
      if (this._hist.length > tail) this._hist = this._hist.slice(-tail);
      this.synced = false;
      this.startSamples = -1;
      this.startIndex = -1;
      this.lengthKnown = false;
      this.payloadLen = 0;
      this._totalSymbols = 0;
      this.state = "searching";
      this.symbolIndex = 0;
      this._lastError = null;
    }

    reset() {
      this._buf = [];
      this._hist = [];
      this._frames = 0;
      this._score = 0;
      this._lastSoft = 0;
      this._lastBin = -1;
      this._measuredHz = 0;
      this._crc = null;
      this._lastError = null;
      this._totalSymbols = 0;
      this.synced = false;
      this.startSamples = -1;
      this.startIndex = -1;
      this.lengthKnown = false;
      this.payloadLen = 0;
      this.state = "searching";
      this.symbolIndex = 0;
    }

    /* ------------------------------------------------------------ */
    /* Debug                                                          */
    /* ------------------------------------------------------------ */

    getDebug() {
      const totalSymbols = this._totalSymbols || 0;
      return {
        state: this.state,
        measuredHz: Math.round(this._measuredHz),
        toneHz: Math.round((QF_TONES[this._lastBin] || 0)),
        lastSoft: Number(this._lastSoft.toFixed(3)),
        lastBit: this._lastBin >= 0 ? this._lastBin : null,
        frameIndex: this._frames,
        symbolIndex: this.synced ? this.symbolIndex : 0,
        totalSymbols: totalSymbols,
        totalBits: totalSymbols * QF_TONE_BITS,
        bitProgress: this.synced
          ? Math.min(totalSymbols, this.symbolIndex) + " / " + totalSymbols
          : "—",
        payloadLen: this.lengthKnown ? this.payloadLen : null,
        score: Number(this._score.toFixed(3)),
        scoreSync: NaN,
        lastError: this._lastError,
      };
    }
  }

  SS.QuadDecoder = QuadDecoder;
  SS.QuadDecoderConstants = {
    SYMBOL_SECONDS: QF_SYMBOL_SECONDS,
    FRAME_SECONDS: QF_FRAME_SECONDS,
    FRAMES_PER_SYMBOL: QF_FRAMES_PER_SYMBOL,
    TONES: QF_TONES,
    PREAMBLE_SYMS: QF_PREAMBLE_SYMS,
    SCORE_LOCK: QF_SCORE_LOCK,
    SCORE_HIGH: QF_SCORE_HIGH,
    ABS_MIN: QF_ABS_MIN,
  };
})();