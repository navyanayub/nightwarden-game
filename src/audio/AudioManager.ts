/**
 * Minimal WebAudio manager. Stage 1: a synthesised engine note that follows RPM/throttle
 * and a soft city ambience bed. Created on the first user gesture (autoplay policy).
 * Stage 2 expands this (traffic, crowds, weather, positional audio).
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private oscA!: OscillatorNode;
  private oscB!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private ambience!: GainNode;
  private paused = false;

  unlock(): void {
    if (this.ctx) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);
    // Engine: two detuned saw/square oscillators through a lowpass.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 600;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscB = ctx.createOscillator();
    this.oscB.type = 'square';
    this.oscA.connect(this.engineFilter);
    this.oscB.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.oscA.start();
    this.oscB.start();
    // Ambience: looping filtered noise (distant traffic / sea).
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = last * 0.985 + (Math.random() * 2 - 1) * 0.015;
      data[i] = last * 6;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    this.ambience = ctx.createGain();
    this.ambience.gain.value = 0.12;
    src.connect(lp).connect(this.ambience).connect(this.master);
    src.start();
  }

  setEngine(on: boolean, rpm: number, throttle: number): void {
    if (!this.ctx || this.paused) return;
    const t = this.ctx.currentTime;
    const f = 38 + rpm * 120;
    this.oscA.frequency.setTargetAtTime(f, t, 0.05);
    this.oscB.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(300 + rpm * 900 + throttle * 600, t, 0.08);
    this.engineGain.gain.setTargetAtTime(on ? 0.05 + throttle * 0.06 : 0, t, 0.12);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (!this.ctx) return;
    if (p) void this.ctx.suspend();
    else void this.ctx.resume();
  }
}
