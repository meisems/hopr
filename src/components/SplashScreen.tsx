import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BlackHoleRenderer, flatLogoHeightPx, type BlackHoleFrame } from './splash/blackHoleRenderer';

interface SplashScreenProps {
  isExiting: boolean;
  onExitStart: () => void;
  onExitComplete: () => void;
  /** Black-hole spin a* (0–0.998): drags the disk's inner edge inward. */
  spin: number;
  /** Viewing inclination in degrees from the spin axis (90 = edge-on). */
  inclination: number;
}

const FADE_MS = 420;

// Timeline (seconds). The Hopr mark sits far behind a black hole, so gravity
// bends it into an Einstein ring; then the hole evaporates, spacetime
// flattens, the ring snaps back into the logo and a Hawking flash clears the
// screen.
const T = {
  lensed: 0.35, // ring appears
  evaporateStart: 2.2,
  evaporateEnd: 3.25,
  flash: 3.42,
  handoff: 3.4, // crisp DOM logo takes over from the shader, under the flash
  exit: 4.3,
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smooth = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;

const START_DISTANCE = 44;
const END_DISTANCE = 26;

function frameAt(time: number): BlackHoleFrame {
  const evaporation = clamp01((time - T.evaporateStart) / (T.evaporateEnd - T.evaporateStart));
  return {
    time,
    // Evaporation accelerates at the end, like a real Hawking-radiating hole.
    mass: Math.max(0, 1 - Math.pow(evaporation, 1.7)),
    disk: smooth(0.1, 1.1, time) * (1 - smooth(T.evaporateStart + 0.15, T.evaporateEnd - 0.1, time)),
    logo: smooth(T.lensed, T.lensed + 0.9, time),
    flash: time < T.flash ? 0 : Math.min(1, (time - T.flash) / 0.75),
    exposure: smooth(0, 0.7, time),
    // A slow drift around the hole that settles face-on as it evaporates.
    azimuth: -0.55 * (1 - easeInOutSine(time / T.evaporateEnd)),
    distance: START_DISTANCE - (START_DISTANCE - END_DISTANCE) * easeOutCubic(time / 2.6),
  };
}

function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || Math.min(window.innerWidth, window.innerHeight) < 600;
}

export default function SplashScreen(props: SplashScreenProps) {
  const [fallback, setFallback] = useState(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches || !document.createElement('canvas').getContext('webgl');
    } catch {
      return true;
    }
  });
  return fallback ? <CssSplash {...props} /> : <LensingSplash {...props} onUnsupported={() => setFallback(true)} />;
}

/** The ray-traced black hole (WebGL). */
function LensingSplash({ isExiting, onExitStart, onExitComplete, spin, inclination, onUnsupported }: SplashScreenProps & { onUnsupported: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [handoff, setHandoff] = useState(false);
  const [logoHeight, setLogoHeight] = useState(0);
  const finished = useRef(false);
  const callbacks = useRef({ onExitStart, onExitComplete, onUnsupported });
  callbacks.current = { onExitStart, onExitComplete, onUnsupported };
  const timers = useRef<number[]>([]);

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    callbacks.current.onExitStart();
    timers.current.push(window.setTimeout(() => callbacks.current.onExitComplete(), FADE_MS));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: BlackHoleRenderer;
    try {
      renderer = new BlackHoleRenderer(canvas, { inclinationDeg: inclination, spin, mobile: isMobile() });
    } catch {
      callbacks.current.onUnsupported();
      return;
    }

    const image = new Image();
    image.onload = () => renderer.setLogo(image);
    image.src = '/brand/logo-icon.png';

    const updateLogoSize = () => setLogoHeight(flatLogoHeightPx(window.innerWidth, window.innerHeight, END_DISTANCE));
    updateLogoSize();
    const onResize = () => {
      renderer.resize();
      updateLogoSize();
    };
    window.addEventListener('resize', onResize);

    let raf = 0;
    let start = 0;
    let last = 0;
    let slowFrames = 0;
    let sampled = 0;
    let handedOff = false;
    // Dev-only inspection: localStorage['hopr-splash-at'] = '2.8' freezes the animation at that second.
    const frozen = (import.meta.env as { DEV?: boolean }).DEV ? Number(window.localStorage.getItem('hopr-splash-at')) || null : null;
    const tick = (now: number) => {
      if (!start) start = now;
      const time = frozen ?? (now - start) / 1000;
      // Adaptive quality: sustained slow frames lower the internal resolution.
      if (last) {
        const delta = now - last;
        sampled += 1;
        if (sampled > 4 && delta > 26) slowFrames += 1;
        if (slowFrames >= 4) {
          slowFrames = 0;
          renderer.degrade();
        }
      }
      last = now;
      renderer.render(frameAt(time));
      if (!handedOff && time >= T.handoff) {
        handedOff = true;
        setHandoff(true);
      }
      if (time >= T.exit && frozen === null) {
        finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onLost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(raf);
      finish();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('webglcontextlost', onLost);
      timers.current.forEach((timer) => window.clearTimeout(timer));
      renderer.dispose();
    };
    // Settings are read once per run; the Settings preview remounts the splash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`lens-overlay${isExiting ? ' lens-overlay--exit' : ''}`} style={{ '--hs-fade': `${FADE_MS}ms` } as CSSProperties} onClick={finish} role="presentation">
      <canvas ref={canvasRef} className="lens-canvas" aria-hidden="true" />
      <div className={`lens-brand${handoff ? ' lens-brand--on' : ''}`}>
        <img src="/brand/logo-icon.png" alt="" draggable={false} style={{ height: logoHeight || undefined }} className="lens-mark" />
        <div className="lens-wordmark" aria-label="hopr">
          {'hopr'.split('').map((letter, index) => (
            <span key={index} style={{ transitionDelay: `${120 + index * 60}ms` }}>{letter}</span>
          ))}
        </div>
        <div className="lens-tagline">Hop across chains</div>
      </div>
      <div className="lens-hint">Tap to skip</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fallback for devices without WebGL or with reduced motion (CSS only).
// ---------------------------------------------------------------------------

const COLLAPSE_AT = 1750;
const EXIT_AT = 2250;
const REDUCED_EXIT_AT = 650;

function CssSplash({ isExiting, onExitStart, onExitComplete, spin, inclination }: SplashScreenProps) {
  const [stage, setStage] = useState<'intro' | 'collapse'>('intro');
  const exitStartRef = useRef(onExitStart);
  const exitCompleteRef = useRef(onExitComplete);
  exitStartRef.current = onExitStart;
  exitCompleteRef.current = onExitComplete;
  const timersRef = useRef<number[]>([]);
  const finishedRef = useRef(false);

  const finish = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    exitStartRef.current();
    timersRef.current = [window.setTimeout(() => exitCompleteRef.current(), FADE_MS)];
  };

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    timersRef.current = reduced
      ? [window.setTimeout(finish, REDUCED_EXIT_AT)]
      : [window.setTimeout(() => setStage('collapse'), COLLAPSE_AT), window.setTimeout(finish, EXIT_AT)];
    return () => timersRef.current.forEach((timer) => window.clearTimeout(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = {
    '--hs-turn': `${(4.8 - spin * 2.9).toFixed(2)}s`,
    '--hs-tilt': `${Math.round(Math.min(82, Math.max(0, inclination)))}deg`,
    '--hs-fade': `${FADE_MS}ms`,
  } as CSSProperties;

  return (
    <div className={`hs-overlay${stage === 'collapse' ? ' hs-overlay--collapse' : ''}${isExiting ? ' hs-overlay--exit' : ''}`} style={style} onClick={finish} role="presentation">
      <div className="hs-stars hs-stars--far" />
      <div className="hs-stars hs-stars--near" />
      <div className="hs-aura" />
      <div className="hs-stage">
        <div className="hs-disk-tilt">
          <div className="hs-disk" />
          <div className="hs-disk hs-disk--inner" />
        </div>
        <div className="hs-photon-ring" />
        <div className="hs-core" />
        <div className="hs-mark">
          <img src="/brand/logo-icon.png" alt="" draggable={false} />
        </div>
      </div>
      <div className="hs-brand">
        <div className="hs-wordmark" aria-label="hopr">
          {'hopr'.split('').map((letter, index) => (
            <span key={index} style={{ animationDelay: `${620 + index * 70}ms` }}>{letter}</span>
          ))}
        </div>
        <div className="hs-tagline">Scan it. Route it. Trade it.</div>
        <div className="hs-progress"><span /></div>
      </div>
    </div>
  );
}
