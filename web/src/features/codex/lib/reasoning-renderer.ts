/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
export type ReasoningPaint = {
  progress: number
  level: number
  flowing: boolean
  ultra: boolean
}
export type ReasoningRenderer = {
  setTarget: (paint: ReasoningPaint) => void
  dispose: () => void
}

const vertexSource = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`

// A continuous spatial field travels rightward. Time never restarts when a tier changes.
const fragmentSource = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 resolution;
uniform float pixelRatio;
uniform float progress;
uniform float level;
uniform float flow;
uniform float time;
uniform float particleTravel;
uniform float particles;
float roundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}
void main() {
  vec2 size = resolution / pixelRatio;
  vec2 p = gl_FragCoord.xy / pixelRatio;
  float center = 13.0 + (size.x - 26.0) * progress;
  float width = center + 13.0;
  float bar = 1.0 - smoothstep(-0.6, 0.6,
    roundedBox(p - vec2(width * 0.5, 14.0), vec2(width * 0.5, 12.0), 12.0));
  float distance = length(p - vec2(center, 14.0));
  bar *= smoothstep(12.5, 13.1, distance);
  float core = (1.0 - smoothstep(8.7, 9.3, distance)) * flow;
  vec2 uv = p / size;
  vec3 blue = vec3(0.231, 0.510, 0.965);
  vec3 violet = vec3(0.545, 0.361, 0.965);
  vec3 cyan = vec3(0.220, 0.741, 0.973);
  vec3 base = mix(vec3(0.220, 0.660, 0.940), blue, smoothstep(0.0, 0.2, level));
  base = mix(base, vec3(0.388, 0.400, 0.945), smoothstep(0.2, 0.4, level));
  base = mix(base, violet, smoothstep(0.4, 0.6, level));
  base = mix(base, vec3(0.706, 0.298, 0.894), smoothstep(0.6, 0.8, level));
  base = mix(base, violet, smoothstep(0.8, 1.0, level));
  base = mix(base, cyan, 0.12 * uv.x * (1.0 - level));
  float phase = uv.x * 1.85 - time * 0.42
    + 0.09 * sin(uv.y * 3.0 + uv.x * 4.0 - time * 0.4);
  float wave = 0.5 + 0.5 * sin(6.2831853 * phase);
  float light = 0.5 + 0.5 * sin(6.2831853 * (phase + 0.28));
  vec3 fluid = mix(violet, blue, smoothstep(0.12, 0.90, wave));
  fluid = mix(fluid, cyan, pow(light, 4.0) * 0.92);
  fluid += vec3(0.10, 0.07, 0.13) * pow(light, 12.0);
  vec3 color = mix(base, fluid, flow);
  // Separate bright heads and leftward tails accelerate from left to right.
  // Each flight wraps outside the clipped track, so there is no visible reset.
  float sparks = 0.0;
  for (int i = 0; i < 12; i++) {
    float seed = fract(sin(float(i) * 41.73 + 7.91) * 173.31);
    float flight = fract(particleTravel * (0.82 + seed * 0.38) + seed);
    float headX = (pow(flight, 1.55) * 1.4 - 0.2) * size.x;
    float lane = 5.0 + fract(seed * 7.23 + float(i) * 0.31) * 18.0;
    float dx = p.x - headX;
    float dy = p.y - lane;
    float tailLength = mix(6.0, 18.0, flight);
    float head = exp(-dx * dx / 1.8 - dy * dy / 0.70);
    float tail = exp(min(dx, 0.0) / tailLength - dy * dy / 0.32)
      * step(dx, 0.0) * smoothstep(-tailLength * 3.0, -tailLength, dx) * 0.46;
    sparks += head + tail;
  }
  color = mix(color, vec3(0.91, 0.98, 1.0), min(sparks * particles, 0.94));
  float alpha = max(bar, core);
  gl_FragColor = vec4(color * alpha, alpha);
}
`

export function createReasoningRenderer(
  canvas: HTMLCanvasElement,
  track: HTMLElement,
  initial: ReasoningPaint
): ReasoningRenderer {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let target = initial
  let progress = initial.progress
  let level = initial.level
  let flow = Number(initial.flowing)
  let particles = 0
  let particleAge = 0
  let particleTravel = 0
  let velocity = 0
  let elapsed = 0
  let lastFrame = 0
  let frame = 0
  let disposed = false
  let gl: WebGLRenderingContext | null = null
  let program: WebGLProgram | null = null
  let buffer: WebGLBuffer | null = null
  let uniforms: Record<string, WebGLUniformLocation | null> = {}
  let width = track.clientWidth

  function releaseGpu(): void {
    if (buffer) gl?.deleteBuffer(buffer)
    if (program) gl?.deleteProgram(program)
    buffer = null
    program = null
  }

  function initializeGpu(): void {
    releaseGpu()
    track.dataset.renderer = 'fallback'
    if (typeof window.WebGLRenderingContext === 'undefined') return
    try {
      gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        powerPreference: 'low-power',
      })
      if (!gl || gl.isContextLost()) return
      program = gl.createProgram()
      if (!program) return
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, vertexSource],
        [gl.FRAGMENT_SHADER, fragmentSource],
      ] as const) {
        const shader = gl.createShader(kind)
        if (!shader) throw new Error('Shader unavailable')
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          gl.deleteShader(shader)
          throw new Error('Shader compilation failed')
        }
        gl.attachShader(program, shader)
        gl.deleteShader(shader)
      }
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('Shader linking failed')
      }
      gl.useProgram(program)
      buffer = gl.createBuffer()
      if (!buffer) throw new Error('Shader buffer unavailable')
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      )
      const position = gl.getAttribLocation(program, 'position')
      gl.enableVertexAttribArray(position)
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
      const context = gl
      const linkedProgram = program
      uniforms = Object.fromEntries(
        [
          'resolution',
          'pixelRatio',
          'progress',
          'level',
          'flow',
          'time',
          'particleTravel',
          'particles',
        ].map((name) => [name, context.getUniformLocation(linkedProgram, name)])
      )
      track.dataset.renderer = 'webgl'
    } catch {
      releaseGpu()
    }
  }

  function render(now: number): void {
    frame = 0
    if (disposed || document.hidden) return
    const delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 1 / 60
    lastFrame = now
    const blend = motion.matches ? 1 : 1 - Math.exp(-delta / 0.1)
    if (motion.matches) {
      progress = target.progress
      velocity = 0
    } else {
      // Exact critically damped spring: frame-rate independent and never overshoots.
      const offset = progress - target.progress
      const decay = Math.exp(-20 * delta)
      const spring = velocity + offset * 20
      progress = target.progress + (offset + spring * delta) * decay
      velocity = (velocity - spring * 20 * delta) * decay
    }
    level += (target.level - level) * blend
    const fade = motion.matches ? 1 : 1 - Math.exp(-delta / 0.16)
    flow += (Number(target.flowing) - flow) * fade
    particles += (Number(target.ultra && !motion.matches) - particles) * fade
    if (!motion.matches) {
      elapsed += delta
      if (target.ultra) particleAge += delta
      particleTravel +=
        delta * (0.06 + 0.92 * (1 - Math.exp(-particleAge / 0.65)))
    }
    // Only transforms/paint properties change; no per-frame layout reads or React updates.
    track.style.setProperty(
      '--codex-reasoning-offset',
      `${Math.max(0, width - 26) * progress}px`
    )
    track.style.setProperty(
      '--codex-reasoning-cut',
      `${Math.max(0, width - 13 - Math.max(0, width - 26) * progress)}px`
    )
    track.style.setProperty(
      '--codex-reasoning-particles-opacity',
      `${particles}`
    )
    if (gl && program && !gl.isContextLost()) {
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height)
      gl.uniform1f(uniforms.pixelRatio, canvas.width / Math.max(1, width))
      gl.uniform1f(uniforms.progress, progress)
      gl.uniform1f(uniforms.level, level)
      gl.uniform1f(uniforms.flow, flow)
      gl.uniform1f(uniforms.time, elapsed)
      gl.uniform1f(uniforms.particleTravel, particleTravel)
      gl.uniform1f(uniforms.particles, particles)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    const moving =
      Math.abs(target.progress - progress) +
        Math.abs(target.level - level) +
        Math.abs(Number(target.flowing) - flow) +
        Math.abs(Number(target.ultra && !motion.matches) - particles) >
      0.0001
    if (!motion.matches && (moving || (target.flowing && program))) schedule()
  }

  function schedule(): void {
    if (!frame && !disposed && !document.hidden) {
      frame = requestAnimationFrame(render)
    }
  }

  const resize = new ResizeObserver((entries) => {
    width = entries[0].contentRect.width
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(width * ratio))
    canvas.height = Math.round(28 * ratio)
    schedule()
  })
  const visibility = () => {
    cancelAnimationFrame(frame)
    frame = 0
    lastFrame = 0
    schedule()
  }
  const lost = (event: Event) => {
    event.preventDefault()
    releaseGpu()
    track.dataset.renderer = 'fallback'
    schedule()
  }
  const restored = () => {
    initializeGpu()
    schedule()
  }
  canvas.addEventListener('webglcontextlost', lost)
  canvas.addEventListener('webglcontextrestored', restored)
  document.addEventListener('visibilitychange', visibility)
  motion.addEventListener('change', visibility)
  initializeGpu()
  resize.observe(track)

  return {
    setTarget: (next) => {
      if (next.ultra && !target.ultra) {
        particleAge = 0
        particleTravel = 0
      }
      target = next
      if (!frame) lastFrame = 0
      schedule()
    },
    dispose: () => {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('webglcontextrestored', restored)
      document.removeEventListener('visibilitychange', visibility)
      motion.removeEventListener('change', visibility)
      releaseGpu()
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
