import { useSyncExternalStore } from 'react';

/**
 * Synthesised sound effects (Web Audio, no asset files). Browsers only allow
 * audio after a user gesture, so the context is unlocked on the first click.
 */
export type Sfx = 'roll' | 'place' | 'pickup' | 'fall' | 'stuck' | 'turn' | 'win' | 'click';

const MUTE_KEY = 'gravitas-muted';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = readMuted();
const listeners = new Set<() => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function audio(): AudioContext | null {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

if (typeof window !== 'undefined') {
  const unlock = () => audio();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

export function isMuted() {
  return muted;
}

export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    // storage blocked: the setting just won't persist
  }
  listeners.forEach((f) => f());
}

export function useMuted(): boolean {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => muted,
  );
}

interface ToneOpts { type?: OscillatorType; gain?: number; at?: number; slideTo?: number; attack?: number }

function tone(ac: AudioContext, freq: number, dur: number, { type = 'sine', gain = 0.3, at = 0, slideTo, attack = 0.005 }: ToneOpts = {}) {
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master!);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

let noiseBuf: AudioBuffer | null = null;

/** A filtered noise burst: stone clacks, rattles and rumbles. */
function noise(ac: AudioContext, dur: number, { freq = 3000, q = 0.8, gain = 0.3, at = 0 } = {}) {
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ac.currentTime + at;
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(master!);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

const arpeggio = (ac: AudioContext, notes: number[], step: number, dur: number, opts: ToneOpts = {}) =>
  notes.forEach((f, i) => tone(ac, f, dur, { ...opts, at: (opts.at ?? 0) + i * step }));

export function play(sfx: Sfx) {
  if (muted) return;
  const ac = audio();
  if (!ac || ac.state !== 'running') return;
  switch (sfx) {
    case 'roll':
      // A die rattling in a cupped hand, then landing.
      for (let i = 0; i < 6; i++) noise(ac, 0.05, { freq: 2500 + Math.random() * 2000, q: 2, gain: 0.18, at: i * 0.09 + Math.random() * 0.03 });
      noise(ac, 0.12, { freq: 900, q: 1.2, gain: 0.35, at: 0.6 });
      break;
    case 'place':
      // Stone on stone: a short knock with a hard click.
      noise(ac, 0.09, { freq: 1600, q: 1.5, gain: 0.45 });
      tone(ac, 190, 0.12, { type: 'triangle', gain: 0.25, slideTo: 140 });
      break;
    case 'pickup':
      noise(ac, 0.15, { freq: 3000, q: 0.8, gain: 0.15 });
      arpeggio(ac, [440, 660], 0.06, 0.15, { type: 'triangle', gain: 0.12 });
      break;
    case 'fall':
      for (let i = 0; i < 5; i++) noise(ac, 0.12, { freq: 500 + Math.random() * 900, q: 1.2, gain: 0.4, at: i * 0.11 + Math.random() * 0.05 });
      tone(ac, 160, 0.6, { type: 'sawtooth', gain: 0.12, slideTo: 55 });
      break;
    case 'stuck':
      arpeggio(ac, [392, 311], 0.12, 0.25, { type: 'triangle', gain: 0.16 });
      break;
    case 'turn':
      tone(ac, 880, 0.35, { gain: 0.18 });
      tone(ac, 1320, 0.45, { gain: 0.1, at: 0.08 });
      break;
    case 'win':
      arpeggio(ac, [392, 523, 659, 784], 0.12, 0.3, { type: 'square', gain: 0.07 });
      arpeggio(ac, [523, 659, 784, 1047], 0, 1.4, { type: 'triangle', gain: 0.12, at: 0.5 });
      break;
    case 'click':
      tone(ac, 1200, 0.05, { type: 'square', gain: 0.05 });
      break;
  }
}
