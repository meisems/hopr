import{r as c,j as r}from"./index-C1_5-UDF.js";const G=`
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`,B=s=>`
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define STEPS ${s}

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
`;function U(s,a){return .72*Math.max(1,a/Math.max(s,1)*.95)}const w={halfHeight:2.4,aspect:464/306,distance:16};function q(s,a,e){const t=U(s,a);return 2*w.halfHeight/(t*(e+w.distance))*a}class O{constructor(a,e){this.canvas=a,this.uniforms={},this.texture=null,this.options=e;const t=a.getContext("webgl",{antialias:!1,alpha:!1,depth:!1,stencil:!1,powerPreference:"high-performance",preserveDrawingBuffer:!1});if(!t)throw new Error("WebGL unavailable");this.gl=t,this.scale=e.mobile?.42:.62,this.program=this.link(e.mobile?72:110);const o=t.createBuffer();t.bindBuffer(t.ARRAY_BUFFER,o),t.bufferData(t.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),t.STATIC_DRAW);const i=t.getAttribLocation(this.program,"aPos");t.enableVertexAttribArray(i),t.vertexAttribPointer(i,2,t.FLOAT,!1,0,0);for(const n of["uRes","uTime","uMass","uDisk","uLogo","uFlash","uExposure","uIncl","uIsco","uAz","uDist","uK","uLogoSize","uLogoDist","uLogoTex"])this.uniforms[n]=t.getUniformLocation(this.program,n);this.texture=t.createTexture(),t.bindTexture(t.TEXTURE_2D,this.texture),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,1,1,0,t.RGBA,t.UNSIGNED_BYTE,new Uint8Array([0,0,0,0])),this.resize()}link(a){const e=this.gl,t=(i,n)=>{const u=e.createShader(i);if(e.shaderSource(u,n),e.compileShader(u),!e.getShaderParameter(u,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(u)??"shader error");return u},o=e.createProgram();if(e.attachShader(o,t(e.VERTEX_SHADER,G)),e.attachShader(o,t(e.FRAGMENT_SHADER,B(a))),e.linkProgram(o),!e.getProgramParameter(o,e.LINK_STATUS))throw new Error(e.getProgramInfoLog(o)??"link error");return e.useProgram(o),o}setLogo(a){const e=this.gl,t=512,o=document.createElement("canvas");o.width=t,o.height=t;const i=o.getContext("2d");if(!i)return;const n=6;i.drawImage(a,n,n,t-n*2,t-n*2),e.bindTexture(e.TEXTURE_2D,this.texture),e.pixelStorei(e.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,o),e.generateMipmap(e.TEXTURE_2D),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR_MIPMAP_LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR)}degrade(){return this.scale<=.28?!1:(this.scale=Math.max(.28,this.scale*.75),this.resize(),!0)}resize(){const a=Math.min(window.devicePixelRatio||1,2),e=Math.max(1,Math.round(window.innerWidth*a*this.scale)),t=Math.max(1,Math.round(window.innerHeight*a*this.scale));(this.canvas.width!==e||this.canvas.height!==t)&&(this.canvas.width=e,this.canvas.height=t),this.gl.viewport(0,0,e,t)}render(a){const e=this.gl,t=this.uniforms,o=3-2.1*Math.pow(Math.min(Math.max(this.options.spin,0),.998),1.6),i=Math.min(Math.max(this.options.inclinationDeg,8),88)*Math.PI/180;e.uniform2f(t.uRes,this.canvas.width,this.canvas.height),e.uniform1f(t.uTime,a.time),e.uniform1f(t.uMass,a.mass),e.uniform1f(t.uDisk,a.disk),e.uniform1f(t.uLogo,a.logo),e.uniform1f(t.uFlash,a.flash),e.uniform1f(t.uExposure,a.exposure),e.uniform1f(t.uIncl,i),e.uniform1f(t.uIsco,o),e.uniform1f(t.uAz,a.azimuth),e.uniform1f(t.uDist,a.distance),e.uniform1f(t.uK,U(window.innerWidth,window.innerHeight)),e.uniform2f(t.uLogoSize,w.halfHeight*w.aspect,w.halfHeight),e.uniform1f(t.uLogoDist,w.distance),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.texture),e.uniform1i(t.uLogoTex,0),e.drawArrays(e.TRIANGLES,0,3)}dispose(){var a;(a=this.gl.getExtension("WEBGL_lose_context"))==null||a.loseContext()}}const y=420,l={lensed:.35,evaporateStart:2.2,evaporateEnd:3.25,flash:3.42,handoff:3.4,exit:4.3},A=s=>Math.min(1,Math.max(0,s)),R=(s,a,e)=>{const t=A((e-s)/(a-s));return t*t*(3-2*t)},$=s=>1-Math.pow(1-A(s),3),W=s=>-(Math.cos(Math.PI*A(s))-1)/2,F=44,C=26;function K(s){const a=A((s-l.evaporateStart)/(l.evaporateEnd-l.evaporateStart));return{time:s,mass:Math.max(0,1-Math.pow(a,1.7)),disk:R(.1,1.1,s)*(1-R(l.evaporateStart+.15,l.evaporateEnd-.1,s)),logo:R(l.lensed,l.lensed+.9,s),flash:s<l.flash?0:Math.min(1,(s-l.flash)/.75),exposure:R(0,.7,s),azimuth:-.55*(1-W(s/l.evaporateEnd)),distance:F-(F-C)*$(s/2.6)}}function Y(){return/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||Math.min(window.innerWidth,window.innerHeight)<600}function ae(s){const[a,e]=c.useState(()=>{try{return window.matchMedia("(prefers-reduced-motion: reduce)").matches||!document.createElement("canvas").getContext("webgl")}catch{return!0}});return a?r.jsx(ee,{...s}):r.jsx(V,{...s,onUnsupported:()=>e(!0)})}function V({isExiting:s,onExitStart:a,onExitComplete:e,spin:t,inclination:o,onUnsupported:i}){const n=c.useRef(null),[u,E]=c.useState(!1),[p,T]=c.useState(0),g=c.useRef(!1),v=c.useRef({onExitStart:a,onExitComplete:e,onUnsupported:i});v.current={onExitStart:a,onExitComplete:e,onUnsupported:i};const d=c.useRef([]),f=()=>{g.current||(g.current=!0,v.current.onExitStart(),d.current.push(window.setTimeout(()=>v.current.onExitComplete(),y)))};return c.useEffect(()=>{const x=n.current;if(!x)return;let h;try{h=new O(x,{inclinationDeg:o,spin:t,mobile:Y()})}catch{v.current.onUnsupported();return}const k=new Image;k.onload=()=>h.setLogo(k),k.src="/brand/logo-icon.png";const M=()=>T(q(window.innerWidth,window.innerHeight,C));M();const I=()=>{h.resize(),M()};window.addEventListener("resize",I);let b=0,L=0,_=0,S=0,z=0,N=!1;const H=null,P=m=>{L||(L=m);const D=(m-L)/1e3;if(_){const X=m-_;z+=1,z>4&&X>26&&(S+=1),S>=4&&(S=0,h.degrade())}if(_=m,h.render(K(D)),!N&&D>=l.handoff&&(N=!0,E(!0)),D>=l.exit&&H===null){f();return}b=requestAnimationFrame(P)};b=requestAnimationFrame(P);const j=m=>{m.preventDefault(),cancelAnimationFrame(b),f()};return x.addEventListener("webglcontextlost",j),()=>{cancelAnimationFrame(b),window.removeEventListener("resize",I),x.removeEventListener("webglcontextlost",j),d.current.forEach(m=>window.clearTimeout(m)),h.dispose()}},[]),r.jsxs("div",{className:`lens-overlay${s?" lens-overlay--exit":""}`,style:{"--hs-fade":`${y}ms`},onClick:f,role:"presentation",children:[r.jsx("canvas",{ref:n,className:"lens-canvas","aria-hidden":"true"}),r.jsxs("div",{className:`lens-brand${u?" lens-brand--on":""}`,children:[r.jsx("img",{src:"/brand/logo-icon.png",alt:"",draggable:!1,style:{height:p||void 0},className:"lens-mark"}),r.jsx("div",{className:"lens-wordmark","aria-label":"hopr",children:"hopr".split("").map((x,h)=>r.jsx("span",{style:{transitionDelay:`${120+h*60}ms`},children:x},h))}),r.jsx("div",{className:"lens-tagline",children:"Hop across chains"})]}),r.jsx("div",{className:"lens-hint",children:"Tap to skip"})]})}const J=1750,Q=2250,Z=650;function ee({isExiting:s,onExitStart:a,onExitComplete:e,spin:t,inclination:o}){const[i,n]=c.useState("intro"),u=c.useRef(a),E=c.useRef(e);u.current=a,E.current=e;const p=c.useRef([]),T=c.useRef(!1),g=()=>{T.current||(T.current=!0,p.current.forEach(d=>window.clearTimeout(d)),u.current(),p.current=[window.setTimeout(()=>E.current(),y)])};c.useEffect(()=>{const d=window.matchMedia("(prefers-reduced-motion: reduce)").matches;return p.current=d?[window.setTimeout(g,Z)]:[window.setTimeout(()=>n("collapse"),J),window.setTimeout(g,Q)],()=>p.current.forEach(f=>window.clearTimeout(f))},[]);const v={"--hs-turn":`${(4.8-t*2.9).toFixed(2)}s`,"--hs-tilt":`${Math.round(Math.min(82,Math.max(0,o)))}deg`,"--hs-fade":`${y}ms`};return r.jsxs("div",{className:`hs-overlay${i==="collapse"?" hs-overlay--collapse":""}${s?" hs-overlay--exit":""}`,style:v,onClick:g,role:"presentation",children:[r.jsx("div",{className:"hs-stars hs-stars--far"}),r.jsx("div",{className:"hs-stars hs-stars--near"}),r.jsx("div",{className:"hs-aura"}),r.jsxs("div",{className:"hs-stage",children:[r.jsxs("div",{className:"hs-disk-tilt",children:[r.jsx("div",{className:"hs-disk"}),r.jsx("div",{className:"hs-disk hs-disk--inner"})]}),r.jsx("div",{className:"hs-photon-ring"}),r.jsx("div",{className:"hs-core"}),r.jsx("div",{className:"hs-mark",children:r.jsx("img",{src:"/brand/logo-icon.png",alt:"",draggable:!1})})]}),r.jsxs("div",{className:"hs-brand",children:[r.jsx("div",{className:"hs-wordmark","aria-label":"hopr",children:"hopr".split("").map((d,f)=>r.jsx("span",{style:{animationDelay:`${620+f*70}ms`},children:d},f))}),r.jsx("div",{className:"hs-tagline",children:"Scan it. Route it. Trade it."}),r.jsx("div",{className:"hs-progress",children:r.jsx("span",{})})]})]})}export{ae as default};
