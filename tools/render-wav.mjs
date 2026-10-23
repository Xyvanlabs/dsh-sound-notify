/**
 * 把 lib/client.js 里三个内置音效按完全相同的参数渲染成 WAV，
 * 这样不用装进 DSH、也不用浏览器就能先听见「会响成什么样」。
 *
 * 参数与 lib/client.js 的 PRESETS / tone() 一一对应：
 *   tone(ac, at, freq, duration, peak, type)
 *   gain: 0.0001 --(5ms)-- peak --(到 duration)-- 0.0001（指数衰减）
 *
 * 运行：node tools/render-wav.mjs
 * 产物：preview/completed.wav、preview/interrupted.wav
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 48000
const OUT = fileURLToPath(new URL('../preview/', import.meta.url))
mkdirSync(OUT, { recursive: true })

/** 与 client.js 的 PRESETS 保持逐字一致。 */
const PRESETS = {
  completed: [
    { at: 0, freq: 1046.5, duration: 0.18, peak: 0.3, type: 'sine' },
    { at: 0.13, freq: 1318.5, duration: 0.32, peak: 0.3, type: 'sine' },
  ],
  interrupted: [
    { at: 0, freq: 440.0, duration: 0.16, peak: 0.26, type: 'square' },
    { at: 0.15, freq: 329.6, duration: 0.30, peak: 0.26, type: 'square' },
  ],
  beep: [{ at: 0, freq: 880.0, duration: 0.12, peak: 0.25, type: 'sine' }],
}

/** 振荡器波形：sine 直接取正弦，square 取符号。 */
function wave(type, phase) {
  if (type === 'square') return Math.sin(phase) >= 0 ? 1 : -1
  return Math.sin(phase)
}

/**
 * 复刻 Web Audio 的增益包络：
 * setValueAtTime(0.0001, at) → exponentialRamp(peak, at+0.005) → exponentialRamp(0.0001, at+duration)
 */
function envelope(t, start, duration, peak) {
  const fadeIn = 0.005
  if (t < start) return 0
  const local = t - start
  if (local <= fadeIn) {
    /* 指数插值：v = a * (b/a)^(local/fadeIn) */
    const a = 0.0001
    return a * Math.pow(peak / a, local / fadeIn)
  }
  if (local >= duration) return 0
  const a = peak
  const b = 0.0001
  return a * Math.pow(b / a, (local - fadeIn) / (duration - fadeIn))
}

function render(notes, volume = 1) {
  const total = Math.max(...notes.map((note) => note.at + note.duration)) + 0.05
  const samples = Math.ceil(total * RATE)
  const buffer = new Float32Array(samples)
  for (const note of notes) {
    const peak = note.peak * volume
    for (let i = 0; i < samples; i += 1) {
      const t = i / RATE
      const gain = envelope(t, note.at, note.duration, peak)
      if (gain <= 0) continue
      buffer[i] += wave(note.type, 2 * Math.PI * note.freq * t) * gain
    }
  }
  /* 峰值归一化留 1dB 余量，避免叠加后削顶。 */
  let peakAbs = 0
  for (let i = 0; i < samples; i += 1) peakAbs = Math.max(peakAbs, Math.abs(buffer[i]))
  const scale = peakAbs > 0 ? 0.89 / peakAbs : 1
  for (let i = 0; i < samples; i += 1) buffer[i] *= scale
  return buffer
}

/** 单声道 16-bit PCM WAV。 */
function wav(samples) {
  const dataBytes = samples.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  const body = Buffer.alloc(dataBytes)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    body.writeInt16LE(Math.round(clamped * 32767), i * 2)
  }
  return Buffer.concat([header, body])
}

for (const [name, notes] of Object.entries(PRESETS)) {
  const buffer = render(notes, 1)
  const file = join(OUT, `${name}.wav`)
  const bytes = wav(buffer)
  writeFileSync(file, bytes)
  const seconds = (buffer.length / RATE).toFixed(2)
  console.log(`${name.padEnd(12)} ${seconds}s  ${(bytes.length / 1024).toFixed(1)} KB  -> ${file}`)
}

/* 顺带把两个音一起渲染一份，方便对比着听。 */
const both = new Float32Array(Math.ceil(1.6 * RATE))
const a = render(PRESETS.completed, 1)
const b = render(PRESETS.interrupted, 1)
both.set(a, 0)
both.set(b, Math.ceil(0.8 * RATE))
const abFile = join(OUT, 'ab-compare.wav')
writeFileSync(abFile, wav(both))
console.log(`ab-compare   1.60s  先「正常结束」后「中断」 -> ${abFile}`)
