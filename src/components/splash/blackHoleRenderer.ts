// Real-time gravitational-lensing renderer for the splash screen.
//
// Every pixel traces a light ray backwards from the camera through
// Schwarzschild spacetime (null geodesics integrated with the standard
// a = -3/2 · rs · h² · r̂ / r⁴ form). Rays that cross the equatorial plane pick
// up light from a thin accretion disk (Novikov–Thorne-like temperature
// profile, relativistic Doppler beaming, gravitational redshift, Keplerian
// shear); rays that escape sample a procedural sky and the Hopr mark placed
// far behind the hole, which lensing turns into an Einstein ring. Shrinking
// `mass` to zero flattens spacetime and the ring collapses back into the logo.
//
// Everything is procedural (no textures besides the brand mark) and WebGL 1,
// so it runs on essentially every phone. Resolution adapts to frame time.

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const fragment = (steps: number) => `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define STEPS ${steps}

uniform vec2 uRes;
uniform float uTime;
uniform float uMass;      // Schwarzschild radius rs (1 → 0 as the hole evaporates)
uniform float uDisk;      // accretion disk brightness 0..1
uniform float uLogo;      // brand mark brightness 0..1
uniform float uFlash;     // Hawking burst progress: 0 = not yet, (0,1] = expanding shock
uniform float uExposure;  // global fade-in
uniform float uIncl;      // viewing inclination (radians from the spin axis)
uniform float uIsco;      // inner disk edge in rs (spin pulls it inward)
uniform float uAz;        // camera azimuth
uniform float uDist;      // camera distance in rs
uniform float uK;         // lens field-of-view factor
uniform vec2 uLogoSize;   // half-size of the brand plane (world units)
uniform float uLogoDist;  // brand plane distance behind the hole
uniform sampler2D uLogoTex;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum;
}

// Approximate blackbody tint for a normalised temperature (≈0.3 deep red … 2 blue-white).
vec3 blackbody(float t) {
  t = clamp(t, 0.0, 2.2);
  vec3 c = vec3(1.0, 0.28, 0.05) * smoothstep(0.05, 0.45, t);
  c = mix(c, vec3(1.0, 0.62, 0.30), smoothstep(0.35, 0.8, t));
  c = mix(c, vec3(1.0, 0.90, 0.78), smoothstep(0.75, 1.2, t));
  c = mix(c, vec3(0.78, 0.87, 1.0), smoothstep(1.2, 2.0, t));
  return c;
}

vec3 sky(vec3 d) {
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 3; layer++) {
    float scale = layer == 0 ? 70.0 : (layer == 1 ? 150.0 : 320.0);
    vec3 p = d * scale;
    vec3 cell = floor(p);
    vec3 h = hash33(cell);
    float present = step(layer == 2 ? 0.80 : 0.90, hash13(cell + 17.3));
    vec3 offset = (h - 0.5) * 0.7;
    float dist = length(fract(p) - 0.5 - offset);
    float size = layer == 0 ? 0.11 : 0.08;
    float b = present * smoothstep(size, 0.0, dist) * (0.35 + 1.4 * h.x * h.x) * (layer == 2 ? 0.45 : 1.0);
    float twinkle = 0.82 + 0.18 * sin(uTime * (1.5 + 3.0 * h.z) + h.y * 40.0);
    col += mix(vec3(1.0, 0.80, 0.60), vec3(0.70, 0.84, 1.0), h.y) * b * twinkle;
  }
  // A faint galactic band and teal dust, so lensing visibly drags structure.
  vec3 bandNormal = normalize(vec3(0.32, 1.0, 0.24));
  float band = exp(-pow(dot(d, bandNormal) * 3.6, 2.0));
  float dust = fbm(d * 3.2 + 2.0);
  col += band * (vec3(0.34, 0.33, 0.36) * dust * dust * 0.55 + vec3(0.025, 0.03, 0.04));
  col += vec3(0.01, 0.045, 0.05) * smoothstep(0.45, 0.8, fbm(d * 1.6 + 11.0));
  return col;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

  vec3 cam = uDist * vec3(sin(uIncl) * sin(uAz), cos(uIncl), sin(uIncl) * cos(uAz));
  vec3 fwd = normalize(-cam);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  vec3 dir = normalize(fwd + (uv.x * right + uv.y * up) * uK);

  float rs = uMass;
  vec3 pos = cam;
  vec3 vel = dir;
  vec3 disk = vec3(0.0);
  float alpha = 0.0;
  float glow = 0.0;
  bool captured = false;

  if (rs > 0.004) {
    float h2 = dot(cross(pos, vel), cross(pos, vel));
    float rin = uIsco * rs;
    float rout = 11.0 * rs;
    for (int i = 0; i < STEPS; i++) {
      float r2 = dot(pos, pos);
      float r = sqrt(r2);
      if (r < rs) { captured = true; break; }
      float dt = clamp(0.085 * r / sqrt(rs), 0.035 * rs, 2.4);
      vec3 acc = -1.5 * rs * h2 * pos / (r2 * r2 * r);
      vel += acc * dt;
      vec3 next = pos + vel * dt;
      // Light that grazes the photon sphere lights up as a thin ring.
      float ps = (r - 1.5 * rs) / (0.22 * rs);
      glow += exp(-ps * ps) * dt / rs;

      if (pos.y * next.y < 0.0 && alpha < 0.985) {
        vec3 hit = mix(pos, next, pos.y / (pos.y - next.y));
        float hr = length(hit);
        if (hr > rin && hr < rout) {
          float x = hr / rs;
          float ang = atan(hit.z, hit.x) + uTime * 2.6 / pow(x, 1.5);
          // Stretched radially → thin sheared streaks, like gas smeared by differential rotation.
          vec3 q = vec3(cos(ang) * x * 0.85, sin(ang) * x * 0.85, x * 2.6);
          float turb = fbm(q);
          float lanes = 0.55 + 0.45 * sin(x * 7.0 + turb * 6.0);
          float edge = smoothstep(uIsco, uIsco + 0.9, x) * (1.0 - smoothstep(6.5, 11.0, x));
          float density = edge * (0.25 + 1.2 * turb * turb) * (0.7 + 0.3 * lanes);

          vec3 orbit = normalize(vec3(-hit.z, 0.0, hit.x));
          float beta = min(sqrt(0.5 / x), 0.7);
          float gamma = 1.0 / sqrt(1.0 - beta * beta);
          float doppler = 1.0 / (gamma * (1.0 - beta * dot(orbit, -normalize(vel))));
          float g = doppler * sqrt(max(1.0 - 1.0 / x, 0.03));
          float temperature = 1.55 * pow(uIsco / x, 0.8);

          vec3 emitted = blackbody(temperature * g) * density * pow(g, 3.5) * (0.9 + 1.8 * temperature * temperature) * uDisk;
          float a = clamp(density * 0.85, 0.0, 1.0) * uDisk;
          disk += (1.0 - alpha) * emitted;
          alpha += (1.0 - alpha) * a;
        }
      }
      pos = next;
      if (r > uDist * 1.3 && dot(pos, vel) > 0.0) break;
    }
  }

  vec3 color = disk;
  if (!captured) {
    vec3 d = normalize(vel);
    vec3 background = sky(d);
    // The brand mark hangs far behind the hole; lensing wraps it into an Einstein ring.
    vec3 center = fwd * uLogoDist;
    float facing = dot(d, fwd);
    if (facing > 0.0 && uLogo > 0.001) {
      float t = dot(center - pos, fwd) / facing;
      vec3 q = pos + d * t - center;
      vec2 luv = vec2(dot(q, right), dot(q, up)) / uLogoSize * 0.5 + 0.5;
      if (luv.x > 0.0 && luv.x < 1.0 && luv.y > 0.0 && luv.y < 1.0) {
        vec4 mark = texture2D(uLogoTex, vec2(luv.x, 1.0 - luv.y));
        // Lensed light is magnified along the ring; mipmapped sampling keeps it smooth.
        vec3 tint = mix(vec3(0.25, 0.85, 0.8), vec3(0.75, 1.0, 0.97), 1.0 - clamp(rs, 0.0, 1.0));
        background += tint * mark.a * uLogo * mix(0.55, 2.0, 1.0 - clamp(rs, 0.0, 1.0));
      }
    }
    color += (1.0 - alpha) * background;
  }
  if (!captured) color += glow * vec3(1.0, 0.78, 0.55) * 0.05 * uDisk;

  // Hawking burst: the last of the hole's energy leaves as an expanding shock ring.
  float rad = length(uv);
  if (uFlash > 0.0) {
    float radius = 0.04 + uFlash * 1.25;
    float width = 0.012 + 0.05 * uFlash;
    float fade = pow(1.0 - uFlash, 1.6);
    float ring = exp(-pow((rad - radius) / width, 2.0));
    float wake = smoothstep(radius, radius * 0.4, rad) * 0.045;
    color += vec3(0.7, 1.0, 0.95) * (ring * 1.8 + wake) * fade;
    color += vec3(1.0, 1.0, 0.97) * exp(-rad * 12.0) * 2.5 * pow(1.0 - uFlash, 4.0);
  }

  color *= uExposure;
  color = aces(color * 1.1);
  color *= 1.0 - 0.35 * smoothstep(0.35, 1.1, rad);
  color = pow(color, vec3(0.4545));
  color += (hash13(vec3(gl_FragCoord.xy, uTime * 60.0)) - 0.5) / 255.0;
  gl_FragColor = vec4(color, 1.0);
}
`;

export interface BlackHoleFrame {
  time: number;
  mass: number;
  disk: number;
  logo: number;
  flash: number;
  exposure: number;
  azimuth: number;
  distance: number;
}

export interface BlackHoleOptions {
  inclinationDeg: number;
  spin: number;
  mobile: boolean;
}

/** Lens field-of-view factor; portrait screens widen it so the disk still fits. */
export function lensFactor(width: number, height: number): number {
  return 0.72 * Math.max(1, (height / Math.max(width, 1)) * 0.95);
}

/** Brand plane geometry (world units), shared with the DOM hand-off. */
export const LOGO_PLANE = { halfHeight: 2.4, aspect: 464 / 306, distance: 16 };

/**
 * Screen size (CSS px) of the brand mark once spacetime is flat, so the crisp
 * DOM logo can take over from the shader at exactly the same place.
 */
export function flatLogoHeightPx(width: number, height: number, cameraDistance: number): number {
  const k = lensFactor(width, height);
  return ((2 * LOGO_PLANE.halfHeight) / (k * (cameraDistance + LOGO_PLANE.distance))) * height;
}

export class BlackHoleRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private texture: WebGLTexture | null = null;
  private scale: number;
  private readonly options: BlackHoleOptions;

  constructor(private canvas: HTMLCanvasElement, options: BlackHoleOptions) {
    this.options = options;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.scale = options.mobile ? 0.42 : 0.62;
    this.program = this.link(options.mobile ? 72 : 110);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['uRes', 'uTime', 'uMass', 'uDisk', 'uLogo', 'uFlash', 'uExposure', 'uIncl', 'uIsco', 'uAz', 'uDist', 'uK', 'uLogoSize', 'uLogoDist', 'uLogoTex']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    // 1×1 transparent placeholder until the brand mark loads.
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    this.resize();
  }

  private link(steps: number): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader error');
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment(steps)));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link error');
    gl.useProgram(program);
    return program;
  }

  setLogo(image: HTMLImageElement) {
    const gl = this.gl;
    // Redraw into a power-of-two canvas so WebGL 1 can mipmap it: lensing stretches
    // the mark hugely, and mipmaps keep the Einstein ring smooth instead of aliased.
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return;
    const pad = 6;
    context.drawImage(image, pad, pad, size - pad * 2, size - pad * 2);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  /** Lower the internal resolution when frames run slow (the canvas is upscaled by CSS). */
  degrade(): boolean {
    if (this.scale <= 0.28) return false;
    this.scale = Math.max(0.28, this.scale * 0.75);
    this.resize();
    return true;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(window.innerWidth * dpr * this.scale));
    const height = Math.max(1, Math.round(window.innerHeight * dpr * this.scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  render(frame: BlackHoleFrame) {
    const gl = this.gl;
    const u = this.uniforms;
    // Spin drags the innermost stable orbit inward: 3 rs (a=0) → ~0.7 rs (a→1), eased for looks.
    const isco = 3 - 2.1 * Math.pow(Math.min(Math.max(this.options.spin, 0), 0.998), 1.6);
    const inclination = (Math.min(Math.max(this.options.inclinationDeg, 8), 88) * Math.PI) / 180;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform1f(u.uMass, frame.mass);
    gl.uniform1f(u.uDisk, frame.disk);
    gl.uniform1f(u.uLogo, frame.logo);
    gl.uniform1f(u.uFlash, frame.flash);
    gl.uniform1f(u.uExposure, frame.exposure);
    gl.uniform1f(u.uIncl, inclination);
    gl.uniform1f(u.uIsco, isco);
    gl.uniform1f(u.uAz, frame.azimuth);
    gl.uniform1f(u.uDist, frame.distance);
    gl.uniform1f(u.uK, lensFactor(window.innerWidth, window.innerHeight));
    gl.uniform2f(u.uLogoSize, LOGO_PLANE.halfHeight * LOGO_PLANE.aspect, LOGO_PLANE.halfHeight);
    gl.uniform1f(u.uLogoDist, LOGO_PLANE.distance);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(u.uLogoTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
