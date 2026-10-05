import { useEffect, useRef } from 'react';

export interface IntroProps {
  isExiting: boolean;
  onExitStart: () => void;
  onExitComplete: () => void;
}

// Same geometry as public/brand/logo-mark.svg (see scripts/build-logo.py).
const VIEW_BOX = '114 74 304 362';
// Drawn bottom-up so the stem rises from the baseline.
const STEM = 'M150 400V110';
const ARCH = 'M150 290C150 212 204 180 260 180C326 180 362 228 366 304';
const BALL = { x: 370, y: 388, r: 42 };

// Timeline (ms). The stem rises, the arch draws with the ball riding its tip,
// the ball drops and lands with a ripple, the name settles, then the mark
// glides into the header logo while the overlay dissolves. Nothing else on
// screen: no progress bar, no captions.
const T = {
  stem: [80, 520],
  arch: [380, 1060],
  land: [1060, 1340],
  word: 1160,
  exit: 1900,
  glide: 720,
};
const DRAW_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
const GLIDE_EASE = 'cubic-bezier(0.7, 0, 0.2, 1)';

/**
 * The default loading intro: the Hopr mark draws itself and "hops". Only
 * transform, opacity and stroke-dashoffset animate (Web Animations API), so it
 * stays smooth on low-end phones. Tap / any key skips it.
 */
export default function HopSplash({ isExiting, onExitStart, onExitComplete }: IntroProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<SVGSVGElement>(null);
  const archRef = useRef<SVGPathElement>(null);
  const stemRef = useRef<SVGPathElement>(null);
  const ballRef = useRef<SVGGElement>(null);
  const rippleRefs = useRef<(SVGCircleElement | null)[]>([]);
  const finished = useRef(false);
  const callbacks = useRef({ onExitStart, onExitComplete });
  callbacks.current = { onExitStart, onExitComplete };

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    callbacks.current.onExitStart();
    const root = rootRef.current;
    const mark = markRef.current;
    if (!root || !mark) {
      callbacks.current.onExitComplete();
      return;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 200 : T.glide;
    root.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'ease-in', fill: 'forwards', delay: reduced ? 0 : 120 });
    root.querySelectorAll<HTMLElement>('[data-hop-fade]').forEach((element) => {
      element.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    });

    // Glide the mark into the header logo (FLIP), so the intro hands off to the page.
    const target = document.querySelector('[data-brand-logo]')?.getBoundingClientRect();
    const from = mark.getBoundingClientRect();
    if (!reduced && target && target.width > 0 && from.width > 0) {
      // The header tile draws the mark at ~66% of its height.
      const scale = (target.height * 0.66) / from.height;
      const dx = target.left + target.width / 2 - (from.left + from.width / 2);
      const dy = target.top + target.height / 2 - (from.top + from.height / 2);
      mark.animate(
        [
          { transform: 'none', opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 1, offset: 0.85 },
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
        ],
        { duration, easing: GLIDE_EASE, fill: 'forwards' },
      );
    }
    window.setTimeout(() => callbacks.current.onExitComplete(), duration + (reduced ? 0 : 140));
  };

  useEffect(() => {
    const arch = archRef.current;
    const stem = stemRef.current;
    const ball = ballRef.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timers: number[] = [];
    if (reduced || !arch || !stem || !ball) {
      timers.push(window.setTimeout(finish, 650));
      return () => timers.forEach(window.clearTimeout);
    }

    const animations: Animation[] = [];
    const run = (element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
      animations.push(element.animate(frames, { fill: 'both', ...options }));
    };

    // 1. Stem rises from the baseline.
    run(stem, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { delay: T.stem[0], duration: T.stem[1] - T.stem[0], easing: DRAW_EASE });

    // 2. Arch draws; the ball rides its tip with the same easing, so they stay locked together.
    run(arch, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { delay: T.arch[0], duration: T.arch[1] - T.arch[0], easing: DRAW_EASE });
    const length = arch.getTotalLength();
    const samples = 28;
    const ride: Keyframe[] = Array.from({ length: samples + 1 }, (_, index) => {
      const point = arch.getPointAtLength((length * index) / samples);
      const grow = Math.min(1, index / 5);
      return { transform: `translate(${point.x}px, ${point.y}px) scale(${0.25 + 0.47 * grow})`, opacity: index ? 1 : 0, offset: index / samples };
    });
    run(ball, ride, { delay: T.arch[0], duration: T.arch[1] - T.arch[0], easing: DRAW_EASE });

    // 3. Drop onto the baseline, squash, settle.
    const end = arch.getPointAtLength(length);
    const at = (x: number, y: number, sx: number, sy: number) => `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;
    run(ball, [
      { transform: at(end.x, end.y, 0.72, 0.72), easing: 'cubic-bezier(0.55, 0, 1, 0.45)' },
      { transform: at(BALL.x, BALL.y + 4, 1.16, 0.84), offset: 0.55, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.3)' },
      { transform: at(BALL.x, BALL.y - 7, 0.96, 1.05), offset: 0.78 },
      { transform: at(BALL.x, BALL.y, 1, 1) },
    // forwards only: a backwards fill would override the ride while this waits.
    ], { delay: T.land[0], duration: T.land[1] - T.land[0], fill: 'forwards' });

    // Landing ripples.
    rippleRefs.current.forEach((ripple, index) => {
      if (!ripple) return;
      run(ripple, [{ opacity: 0.75, transform: 'scale(0.9)' }, { opacity: 0, transform: `scale(${2.6 + index * 0.9})` }], {
        delay: T.land[0] + 160 + index * 110, duration: 820, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards',
      });
    });

    timers.push(window.setTimeout(finish, T.exit));
    return () => {
      timers.forEach(window.clearTimeout);
      animations.forEach((animation) => animation.cancel());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const skip = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') finish();
    };
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={rootRef} className={`hop-splash${isExiting ? ' hop-splash--exit' : ''}`} onClick={finish} role="presentation">
      <div className="hop-splash__glow" aria-hidden />
      <div className="hop-splash__center">
        <svg ref={markRef} className="hop-splash__mark" viewBox={VIEW_BOX} aria-hidden>
          <defs>
            <linearGradient id="hop-stroke" x1="130" y1="420" x2="360" y2="150" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#5b3df5" /><stop offset=".55" stopColor="#8b6bff" /><stop offset="1" stopColor="#d4c8ff" />
            </linearGradient>
            <radialGradient id="hop-halo" cx="0" cy="0" r="72" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#3ef0c8" stopOpacity=".55" /><stop offset="1" stopColor="#3ef0c8" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="hop-ball" cx="-12" cy="-14" r="52" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#f4fffb" /><stop offset=".5" stopColor="#7ff5dc" /><stop offset="1" stopColor="#1fd4ad" />
            </radialGradient>
          </defs>
          <g fill="none" stroke="url(#hop-stroke)" strokeWidth="60" strokeLinecap="round">
            <path ref={stemRef} d={STEM} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} />
            <path ref={archRef} d={ARCH} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1} />
          </g>
          {[0].map((index) => (
            <circle
              key={index}
              ref={(element) => { rippleRefs.current[index] = element; }}
              className="hop-splash__ripple"
              cx={BALL.x}
              cy={BALL.y}
              r={BALL.r}
            />
          ))}
          <g ref={ballRef} style={{ transform: `translate(${BALL.x}px, ${BALL.y}px)`, opacity: 0 }}>
            <circle r={72} fill="url(#hop-halo)" />
            <circle r={BALL.r} fill="url(#hop-ball)" />
          </g>
        </svg>

        <div className="hop-splash__word" aria-label="hopr" data-hop-fade>
          {'hopr'.split('').map((letter, index) => (
            <span key={index} style={{ animationDelay: `${T.word + index * 55}ms` }}>{letter}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
