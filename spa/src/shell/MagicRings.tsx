/**
 * MagicRings — поле светящихся дуг для экрана ожидания.
 *
 * Порт эффекта Magic Rings (reactbits.dev, MIT — см. THIRD-PARTY-LICENSES.md) на ЧИСТЫЙ
 * WebGL: в оригинале three.js используется только как обвязка вокруг одного фрагментного
 * шейдера на весь кадр, и тащить ради этого зависимость в окно незачем. Сам шейдер взят
 * дословно — владелец выбрал ИМЕННО этот вид, и «похожая» интерпретация уже один раз
 * стоила переделки; меняется только обвязка.
 *
 * Интерактив оригинала (мышь, hover, вспышка по клику) ВЫРЕЗАН по закону ожидания:
 * фон, отвечающий на руку, обещает управление, которого здесь нет. Соответствующие
 * uniforms прибиты к нулю, а не удалены из шейдера — чтобы код шейдера оставался
 * дословным и его можно было сверять с источником строка в строку.
 *
 * Кадр живёт только пока страница видна (visibilitychange) и компонент смонтирован;
 * prefers-reduced-motion получает один статичный кадр вместо цикла. Машина без WebGL
 * не получает ничего — вызывающий (Waiting) держит запасное поле сам.
 */

import { useEffect, useRef } from 'react'

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

/* Фрагментный шейдер — дословно из источника (reactbits Magic Rings). */
const FRAG = `
precision highp float;

uniform float uTime, uAttenuation, uLineThickness;
uniform float uBaseRadius, uRadiusStep, uScaleRate;
uniform float uOpacity, uNoiseAmount, uRotation, uRingGap;
uniform float uFadeIn, uFadeOut;
uniform float uMouseInfluence, uHoverAmount, uHoverScale, uParallax, uBurst;
uniform float uCoverageAlpha;
uniform vec2 uResolution, uMouse;
uniform vec3 uColor, uColorTwo;
uniform int uRingCount;

const float HP = 1.5707963;
const float CYCLE = 3.45;

float fade(float t) {
  return t < uFadeIn ? smoothstep(0.0, uFadeIn, t) : 1.0 - smoothstep(uFadeOut, CYCLE - 0.2, t);
}

float ring(vec2 p, float ri, float cut, float t0, float px) {
  float t = mod(uTime + t0, CYCLE);
  float r = ri + t / CYCLE * uScaleRate;
  float d = abs(length(p) - r);
  float a = atan(abs(p.y), abs(p.x)) / HP;
  float th = max(1.0 - a, 0.5) * px * uLineThickness;
  float h = (1.0 - smoothstep(th, th * 1.5, d)) + 1.0;
  d += pow(cut * a, 3.0) * r;
  return h * exp(-uAttenuation * d) * fade(t);
}

void main() {
  float px = 1.0 / min(uResolution.x, uResolution.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution.xy) * px;
  float cr = cos(uRotation), sr = sin(uRotation);
  p = mat2(cr, -sr, sr, cr) * p;
  p -= uMouse * uMouseInfluence;
  float sc = mix(1.0, uHoverScale, uHoverAmount) + uBurst * 0.3;
  p /= sc;
  vec3 c = vec3(0.0);
  float coverage = 0.0;
  float rcf = max(float(uRingCount) - 1.0, 1.0);
  for (int i = 0; i < 10; i++) {
    if (i >= uRingCount) break;
    float fi = float(i);
    vec2 pr = p - fi * uParallax * uMouse;
    vec3 rc = mix(uColor, uColorTwo, fi / rcf);
    float ringAmount = ring(pr, uBaseRadius + fi * uRadiusStep, pow(uRingGap, fi), i == 0 ? 0.0 : 2.95 * fi, px);
    c = mix(c, rc, vec3(ringAmount));
    coverage = max(coverage, ringAmount);
  }
  c *= 1.0 + uBurst * 2.0;
  float n = fract(sin(dot(gl_FragCoord.xy + uTime * 100.0, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) * uNoiseAmount;
  float intensity = max(c.r, max(c.g, c.b));
  vec3 emissiveColor = intensity > 0.0001 ? clamp(c / intensity, 0.0, 1.0) : vec3(0.0);
  vec3 outputColor = mix(emissiveColor, clamp(c, 0.0, 1.0), uCoverageAlpha);
  float outputAlpha = mix(intensity, coverage, uCoverageAlpha);
  gl_FragColor = vec4(outputColor, clamp(outputAlpha * uOpacity, 0.0, 1.0));
}
`

/* Вид, выбранный владельцем 01.09.2026: его цвета и его параметры примера, руки выключены. */
const RING_PARAMS = Object.freeze({
  color: [0xa8 / 255, 0x55 / 255, 0xf7 / 255] as const, // #A855F7
  colorTwo: [0x63 / 255, 0x66 / 255, 0xf1 / 255] as const, // #6366F1
  speed: 1,
  ringCount: 6,
  attenuation: 10,
  lineThickness: 2,
  baseRadius: 0.35,
  radiusStep: 0.1,
  scaleRate: 0.1,
  opacity: 1,
  noiseAmount: 0.1,
  rotation: 0,
  ringGap: 1.5,
  fadeIn: 0.7,
  fadeOut: 0.5,
})

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/** true, когда поле реально рисуется — вызывающий по этому решает, держать ли запасное. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return c.getContext('webgl') !== null || c.getContext('experimental-webgl') !== null
  } catch {
    return false
  }
}

export function MagicRings() {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
    const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!gl) return
    host.appendChild(canvas)

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) {
      host.removeChild(canvas)
      return
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      host.removeChild(canvas)
      return
    }
    gl.useProgram(prog)

    // Один треугольник на весь кадр — вся картинка живёт во фрагментном шейдере.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const u = (name: string) => gl.getUniformLocation(prog, name)
    const p = RING_PARAMS
    gl.uniform1f(u('uAttenuation'), p.attenuation)
    gl.uniform1f(u('uLineThickness'), p.lineThickness)
    gl.uniform1f(u('uBaseRadius'), p.baseRadius)
    gl.uniform1f(u('uRadiusStep'), p.radiusStep)
    gl.uniform1f(u('uScaleRate'), p.scaleRate)
    gl.uniform1f(u('uOpacity'), p.opacity)
    gl.uniform1f(u('uNoiseAmount'), p.noiseAmount)
    gl.uniform1f(u('uRotation'), (p.rotation * Math.PI) / 180)
    gl.uniform1f(u('uRingGap'), p.ringGap)
    gl.uniform1f(u('uFadeIn'), p.fadeIn)
    gl.uniform1f(u('uFadeOut'), p.fadeOut)
    gl.uniform1i(u('uRingCount'), p.ringCount)
    gl.uniform3f(u('uColor'), p.color[0], p.color[1], p.color[2])
    gl.uniform3f(u('uColorTwo'), p.colorTwo[0], p.colorTwo[1], p.colorTwo[2])
    // Руки выключены: у ожидания их нет (см. шапку).
    gl.uniform2f(u('uMouse'), 0, 0)
    gl.uniform1f(u('uMouseInfluence'), 0)
    gl.uniform1f(u('uHoverAmount'), 0)
    gl.uniform1f(u('uHoverScale'), 1)
    gl.uniform1f(u('uParallax'), 0)
    gl.uniform1f(u('uBurst'), 0)
    gl.uniform1f(u('uCoverageAlpha'), 0)
    const uTime = u('uTime')
    const uResolution = u('uResolution')

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(host.clientWidth * dpr))
      const h = Math.max(1, Math.round(host.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
        gl.uniform2f(uResolution, w, h)
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    gl.clearColor(0, 0, 0, 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    const draw = (elapsed: number) => {
      gl.uniform1f(uTime, elapsed)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    let frame = 0
    let elapsed = 0
    let lastT = 0
    const animate = (t: number) => {
      frame = requestAnimationFrame(animate)
      const dt = lastT === 0 ? 0 : Math.min(t - lastT, 100)
      lastT = t
      elapsed += dt * 0.001 * p.speed
      draw(elapsed)
    }
    const start = () => {
      if (frame === 0 && !document.hidden) {
        lastT = 0
        frame = requestAnimationFrame(animate)
      }
    }
    const stop = () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        frame = 0
      }
    }
    const onVisibility = () => (document.hidden ? stop() : start())

    if (reduced) {
      // Один покойный кадр из середины цикла: поле видно, но не движется.
      draw(1.2)
    } else {
      document.addEventListener('visibilitychange', onVisibility)
      start()
    }

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      ro.disconnect()
      if (canvas.parentNode === host) host.removeChild(canvas)
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    }
  }, [])

  return <div ref={hostRef} aria-hidden className="absolute inset-0" />
}
