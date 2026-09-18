/**
 * SoundShare — Web Audio engine
 * ---------------------------------------------------------------------------
 * Uses the Web Audio API for both ends of the acoustic link:
 *
 *   Transmitter — schedules one sine oscillator per bit (1000 Hz = 0,
 *                 2000 Hz = 1, 100 ms each) with short raise/cosine ramps to
 *                 avoid clicks. All bits are scheduled up-front on the audio
 *                 clock so timing is glitch-free regardless of UI jank.
 *
 *   Receiver    — captures the microphone through a ScriptProcessorNode and
 *                 forwards raw PCM to the decoder. Processing happens on the
 *                 audio callback thread, so capture continues even if the UI
 *                 tab is throttled. A muted gain keeps the graph alive without
 *                 feeding sound back to the speaker.
 *
 * Both ends deliberately disable echo cancellation / noise suppression /
 * auto gain, because those processors would distort the FSK tones.
 *
 * Exposes:
 *   SS.Audio.createContext()
 *   SS.Audio.Transmitter
 *   SS.Audio.Receiver
 */

(function () {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;
  const SS = (root.SS = root.SS || {});
  const P = SS.Protocol || {};

  /**
   * Creates (and returns) an AudioContext, tolerating vendor prefixes.
   * @returns {AudioContext}
   */
  function createContext() {
    const AC = root.AudioContext || root.webkitAudioContext;
    return new AC();
  }

  /* ====================================================================== */
  /* Transmitter                                                             */
  /* ====================================================================== */

  class Transmitter {
    constructor() {
      this.ctx = null;
      this._nodes = [];      /* osc + gain nodes of the active transmission */
      this._timers = [];     /* progress interval + completion timeout      */
      this.playing = false;
      this._resolveEnd = null;
      this._done = false;
      this._aborted = false;
    }

    /**
     * Ensures an AudioContext exists and is running. Must be called from
     * within a user gesture the first time (browser autoplay policy).
     * @returns {Promise<AudioContext>}
     */
    async ensureContext() {
      if (!this.ctx) this.ctx = createContext();
      if (this.ctx.state !== "running") await this.ctx.resume();
      return this.ctx;
    }

    /**
     * Transmits a packet of bits as a sequence of FSK tones.
     *
     * Each bit schedules:
     *   oscillator(sine) -> envelope gain -> master gain -> destination
     * with a 4 ms linear ramp in/out to suppress clicks at symbol edges.
     *
     * @param {number[]} bits - packet bits (0/1)
     * @param {object} [options]
     * @param {number} [options.volume=0.9] - 0..1 output gain
     * @param {Function} [options.onProgress] - (bitsDone, totalBits)
     * @returns {Promise<boolean>} resolves with false when every tone has
     *   finished, or true if the transmission was aborted via stop().
     */
    async play(bits, options = {}) {
      if (this.playing) await this.stop();
      this._nodes = [];

      const volume = options.volume == null ? 0.9 : options.volume;
      const onProgress = options.onProgress || (() => {});

      const ctx = await this.ensureContext();
      const dur = P.SYMBOL_SECONDS;
      const ramp = 0.004; /* 4 ms click-suppression ramps */

      /* Small lead-in before the first tone so the mic never clips a partial
         first symbol and the packet hits steady state immediately. */
      const t0 = ctx.currentTime + 0.2;

      const master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);

      for (let i = 0; i < bits.length; i++) {
        const freq = bits[i] ? P.FREQ_ONE : P.FREQ_ZERO;
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;

        const g = ctx.createGain();
        const ts = t0 + i * dur;
        const te = ts + dur;

        g.gain.setValueAtTime(0.0001, ts);
        g.gain.linearRampToValueAtTime(1, ts + ramp);
        g.gain.setValueAtTime(1, Math.max(ts + ramp, te - ramp));
        g.gain.linearRampToValueAtTime(0.0001, te);

        osc.connect(g);
        g.connect(master);
        osc.start(ts);
        osc.stop(te + 0.05);

        this._nodes.push(osc, g);
      }

      const total = bits.length;
      this.playing = true;
      this._done = false;
      this._aborted = false;
      this._nodes.push(master);

      /* Progress ticker — reports scheduled bit index as wall time advances. */
      const tick = setInterval(() => {
        const elapsed = Math.min(
          total,
          Math.round((ctx.currentTime - t0) / dur)
        );
        onProgress(elapsed, total);
      }, 80);

      /* Completion timer — the tones really end here. */
      const done = setTimeout(() => {
        clearInterval(tick);
        this.playing = false;
        onProgress(total, total);
        this._cleanup(master);
        if (this._resolveEnd && !this._done) {
          this._done = true;
          this._resolveEnd(this._aborted);
        }
      }, (total * dur + 0.6) * 1000);

      this._timers.push(tick, done);

      return new Promise((resolve) => {
        this._resolveEnd = resolve;
      });
    }

    /**
     * Aborts any in-flight transmission (stops oscillators immediately),
     * resolves the pending play() promise, and clears the timers.
     * @returns {Promise<void>}
     */
    async stop() {
      const resolve = this._resolveEnd;
      this._timers.forEach((t) => {
        if (typeof t === "number") clearTimeout(t);
        else clearInterval(t);
      });
      this._timers = [];
      this.playing = false;
      if (this.ctx) {
        const now = this.ctx.currentTime;
        for (const node of this._nodes) {
          if (node instanceof root.OscillatorNode) {
            try { node.stop(now); } catch (e) { /* already stopped */ }
          }
        }
      }
      this._nodes = [];
      if (resolve && !this._done) {
        this._done = true;
        this._aborted = true;
        resolve(true);
      }
    }

    /** Disconnects the master gain once a transmission is finished. */
    _cleanup(master) {
      try { master.disconnect(); } catch (e) { /* noop */ }
    }
  }

  /* ====================================================================== */
  /* Receiver                                                                */
  /* ====================================================================== */

  class Receiver {
    constructor() {
      this._running = false;
      this._nodes = [];
      this.ctx = null;
      this.stream = null;
    }

    /**
     * Opens the microphone and starts streaming raw PCM into `onSamples`.
     *
     * The ScriptProcessorNode callback runs on a native audio thread, so the
     * sample flow is immune to main-thread timer throttling (foreground or
     * background). We request the DSP-damaging options disabled.
     *
     * @param {Function} onSamples - (Float32Array chunk) PCM in [-1, 1]
     * @returns {Promise<void>}
     */
    async start(onSamples) {
      if (this._running) return;

      /* Create + resume the context inside the user gesture, before the
         async permission prompt, to satisfy autoplay policies. */
      this.ctx = createContext();
      try {
        if (this.ctx.state !== "running") await this.ctx.resume();
      } catch (e) { /* resume may reject on denied autoplay; ignored */ }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });

      const src = this.ctx.createMediaStreamSource(this.stream);

      /* Read PCM in 4096-sample chunks (~93 ms @ 44.1 kHz). */
      const proc = this.ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (event) => {
        onSamples(event.inputBuffer.getChannelData(0));
      };

      /* Muted gain keeps the graph running without speaker feedback. */
      const mute = this.ctx.createGain();
      mute.gain.value = 0;

      src.connect(proc);
      proc.connect(mute);
      mute.connect(this.ctx.destination);

      this._nodes = [src, proc, mute];
      this._running = true;
    }

    /**
     * Stops the microphone, tears the audio graph down, and closes the
     * context so the next start() begins from a clean slate.
     */
    async stop() {
      if (!this._running) return;
      this._running = false;
      for (const node of this._nodes) {
        try { node.disconnect(); } catch (e) { /* noop */ }
      }
      this._nodes = [];
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.ctx && this.ctx.state !== "closed") {
        try { await this.ctx.close(); } catch (e) { /* noop */ }
      }
      this.ctx = null;
    }
  }

  SS.Audio = { createContext, Transmitter, Receiver };
})();