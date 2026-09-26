import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface SplashScreenProps {
  isExiting: boolean;
  onExitStart: () => void;
  onExitComplete: () => void;
  spin: number;
  inclination: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  opacity: number;
  color: string;
  trail: { x: number; y: number }[];
}

// hopr brand teal palette, sampled from the logo mark
const COLORS = ['#3fb0aa', '#277577', '#72d2cb', '#1f6668', '#a8e6e1', '#185254', '#5ecfc7', '#0c2b2c'];

export default function SplashScreen({ isExiting, onExitStart, onExitComplete, spin, inclination }: SplashScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logoTransformRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationRef = useRef<number>(0);
  const startTimeRef = useRef(Date.now());
  const spinRef = useRef(spin);
  const inclinationRef = useRef(inclination);
  spinRef.current = spin;
  inclinationRef.current = inclination;
  const phaseRef = useRef<'logo' | 'forming' | 'pulling' | 'consuming' | 'gone'>('logo');
  const onExitStartRef = useRef(onExitStart);
  const onExitCompleteRef = useRef(onExitComplete);
  onExitStartRef.current = onExitStart;
  onExitCompleteRef.current = onExitComplete;

  const logoScaleRef = useRef(1);
  const logoOpacityRef = useRef(1);
  const logoRotationRef = useRef(0);
  const holeSizeRef = useRef(0);
  const completionTimerRef = useRef<number | null>(null);
  const [shockwave, setShockwave] = useState(false);

  const createParticle = useCallback((w: number, h: number): Particle => {
    const angle = Math.random() * Math.PI * 2;
    const maxDim = Math.max(w, h);
    const distance = maxDim * 0.4 + Math.random() * maxDim * 0.6;
    const cx = w / 2;
    const cy = h / 2;

    return {
      x: cx + Math.cos(angle) * distance,
      y: cy + Math.sin(angle) * distance,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2,
      size: Math.random() * 2.5 + 0.5,
      opacity: Math.random() * 0.8 + 0.2,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      trail: [],
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = window.innerWidth;
    let h = window.innerHeight;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finishSafely = () => {
      if (completionTimerRef.current !== null) return;
      onExitStartRef.current();
      completionTimerRef.current = window.setTimeout(() => {
        completionTimerRef.current = null;
        onExitCompleteRef.current();
      }, 420);
    };
    const resize = () => {
      // A capped backing-store scale prevents 3x/4x-DPR phones from exhausting the GPU.
      const dpr = prefersReducedMotion ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    // Initialize particles based on screen size
    const particleCount = prefersReducedMotion
      ? 72
      : Math.min(220, Math.max(110, Math.floor((w * h) / 7200)));
    particlesRef.current = Array.from({ length: particleCount }, () =>
      createParticle(w, h)
    );

    // Pre-generate static star positions
    const stars = Array.from({ length: prefersReducedMotion ? 100 : 190 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      size: Math.random() < 0.92 ? Math.random() * 1.1 + 0.2 : Math.random() * 2 + 1,
      twinkle: Math.random() * Math.PI * 2,
      warmth: Math.random(),
    }));

    const drawLensedImage = (star: typeof stars[number], centerX: number, centerY: number, imageRadius: number, imageAngle: number, alpha: number, sizeScale: number) => {
      if (imageRadius < holeSizeRef.current * 0.76 || alpha <= 0.01) return;
      const x = centerX + Math.cos(imageAngle) * imageRadius;
      const y = centerY + Math.sin(imageAngle) * imageRadius;
      const color = star.warmth > 0.82 ? '255, 225, 180' : '218, 242, 255';
      ctx.beginPath();
      ctx.arc(x, y, star.size * sizeScale, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${color}, ${Math.min(1, alpha)})`;
      ctx.fill();
      if (star.size > 1.1 && alpha > 0.35) {
        ctx.beginPath();
        ctx.arc(x, y, star.size * sizeScale * 2.8, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color}, ${alpha * 0.12})`;
        ctx.fill();
      }
    };

    // Orbiting "charge" ring shown while the mark is forming
    const chargeDots = Array.from({ length: prefersReducedMotion ? 12 : 18 }, (_, i) => ({
      offset: (i / 14) * Math.PI * 2,
      radiusJitter: Math.random() * 0.15 + 0.9,
    }));

    let previousFrameTime = performance.now();

    const animate = (frameTime: number) => {
      const frameScale = Math.min(2, Math.max(0, (frameTime - previousFrameTime) / (1000 / 60)));
      previousFrameTime = frameTime;
      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      const cx = w / 2;
      const cy = h / 2;
      const minDim = Math.min(w, h);

      // The logo gets a clean moment on its own before the black hole arrives.
      if (elapsed > 1.25 && phaseRef.current === 'logo') {
        phaseRef.current = 'forming';
        setShockwave(true);
      }
      if (elapsed > 1.5 && phaseRef.current === 'forming') {
        phaseRef.current = 'pulling';
      }
      if (elapsed > 1.72 && phaseRef.current === 'pulling') {
        phaseRef.current = 'consuming';
      }
      if (elapsed > 3.15 && phaseRef.current === 'consuming') {
        phaseRef.current = 'gone';
        finishSafely();
        cancelAnimationFrame(animationRef.current);
        return;
      }

      // Update hole size
      const targetHoleSize = phaseRef.current === 'logo' ? 0 :
        phaseRef.current === 'forming' ? minDim * 0.18 :
        phaseRef.current === 'pulling' ? minDim * 0.35 :
        phaseRef.current === 'consuming' ? minDim * 0.46 :
        minDim * 0.6;
      // Let the lens field keep pace with the pull, then ease into its final size.
      const holeEase = phaseRef.current === 'forming' ? 0.28 :
        phaseRef.current === 'pulling' ? 0.14 :
        phaseRef.current === 'consuming' ? 0.11 : 0.08;
      const holeFrameEase = 1 - Math.pow(1 - holeEase, frameScale);
      holeSizeRef.current += (targetHoleSize - holeSizeRef.current) * holeFrameEase;

      // Update logo transform
      if (phaseRef.current === 'pulling') {
        logoScaleRef.current = Math.max(0.35, logoScaleRef.current * Math.pow(0.96, frameScale));
        logoOpacityRef.current = Math.max(0.2, logoOpacityRef.current - 0.018 * frameScale);
      } else if (phaseRef.current === 'consuming') {
        logoScaleRef.current = Math.max(0.008, logoScaleRef.current * Math.pow(0.935, frameScale));
        logoOpacityRef.current = Math.max(0, logoOpacityRef.current - 0.018 * frameScale);
      } else if (phaseRef.current === 'gone') {
        logoScaleRef.current = 0;
        logoOpacityRef.current = 0;
      }

      const spin = spinRef.current;
      const inclination = inclinationRef.current * Math.PI / 180;
      const swallowProgress = Math.min(1, Math.max(0, (elapsed - 1.72) / 1.43));
      logoRotationRef.current += (0.25 + spin * 1.6) * swallowProgress * frameScale;
      const logo = logoTransformRef.current;
      if (logo) {
        const lensSquash = 1 - Math.sin(inclination) * swallowProgress * 0.22;
        logo.style.transform = `scale(${logoScaleRef.current}) rotate(${logoRotationRef.current}deg) scaleY(${lensSquash})`;
        logo.style.opacity = String(logoOpacityRef.current);
        logo.style.filter = phaseRef.current === 'consuming'
          ? `blur(${Math.min(12, (1 - logoScaleRef.current) * (8 + spin * 10))}px) brightness(${1 + swallowProgress * 0.35})`
          : 'none';
      }

      // Gravity strength
      const gravity = phaseRef.current === 'logo' ? 0 :
        phaseRef.current === 'forming' ? 0.8 :
        phaseRef.current === 'pulling' ? 2.6 :
        phaseRef.current === 'consuming' ? 7.2 : 10.0;

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Bend background light into the characteristic paired images around the shadow.
      const lensMix = Math.min(1, holeSizeRef.current / (minDim * 0.16));
      const einsteinRadius = Math.max(1, holeSizeRef.current * 1.1);
      const shadowCx = cx + holeSizeRef.current * 0.045 * spin * Math.sin(inclination);
      const shadowCy = cy;
      if (lensMix < 0.01) {
        // Before the hole forms, keep the background as a cheap twinkling star field.
        stars.forEach((star) => {
          const twinkle = 0.28 + Math.sin(elapsed * (1.4 + star.warmth * 2) + star.twinkle) * 0.24;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
          ctx.fillStyle = star.warmth > 0.82
            ? `rgba(255, 225, 180, ${Math.max(0.04, twinkle)})`
            : `rgba(218, 242, 255, ${Math.max(0.04, twinkle)})`;
          ctx.fill();
        });
      } else {
        // Bend background light into the characteristic paired images around the shadow.
        stars.forEach((star) => {
          const dx = star.x - shadowCx;
          const dy = star.y - shadowCy;
          const betaPixels = Math.sqrt(dx * dx + dy * dy);
          const beta = betaPixels / einsteinRadius;
          const root = Math.sqrt(beta * beta + 4);
          const primaryRadius = einsteinRadius * (beta + root) * 0.5;
          const secondaryRadius = einsteinRadius * (root - beta) * 0.5;
          const magnification = Math.min(3.2, 0.5 + (beta * beta + 2) / (2 * Math.max(beta, 0.06) * root));
          const angle = betaPixels > 0 ? Math.atan2(dy, dx) : 0;
          const twinkle = 0.28 + Math.sin(elapsed * (1.4 + star.warmth * 2) + star.twinkle) * 0.24;
          const primaryX = shadowCx + Math.cos(angle) * primaryRadius;
          const primaryY = shadowCy + Math.sin(angle) * primaryRadius;
          const blendedX = star.x + (primaryX - star.x) * lensMix;
          const blendedY = star.y + (primaryY - star.y) * lensMix;
          const blendedRadius = Math.sqrt((blendedX - shadowCx) ** 2 + (blendedY - shadowCy) ** 2);
          const blendedAngle = Math.atan2(blendedY - shadowCy, blendedX - shadowCx);
          drawLensedImage(star, shadowCx, shadowCy, blendedRadius, blendedAngle, twinkle * (1 - lensMix * 0.18) * Math.sqrt(magnification), 1 + lensMix * (Math.sqrt(magnification) - 1));

          if (beta < 3.6 && lensMix > 0.04) {
            const secondaryMagnification = Math.max(0, magnification - 1);
            drawLensedImage(star, shadowCx, shadowCy, secondaryRadius, angle + Math.PI, twinkle * lensMix * Math.min(0.42, secondaryMagnification * 0.2), 0.8 + Math.sqrt(secondaryMagnification) * 0.2);
          }
        });
      }
      // Update and draw particles
      particlesRef.current.forEach((particle) => {
        // Trail
        particle.trail.push({ x: particle.x, y: particle.y });
        if (particle.trail.length > (prefersReducedMotion ? 3 : 7)) particle.trail.shift();

        // Gravity toward center
        const dx = cx - particle.x;
        const dy = cy - particle.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 1) {
          const force = (gravity * 80) / (dist * dist + 200);
          particle.vx += (dx / dist) * force * frameScale;
          particle.vy += (dy / dist) * force * frameScale;

          // Orbital component
          const orbForce = gravity * (0.035 + spin * 0.2);
          particle.vx += (-dy / dist) * orbForce * 0.08 * frameScale;
          particle.vy += (dx / dist) * orbForce * 0.08 * frameScale;
        }

        // Velocity damping
        const damping = Math.pow(0.985, frameScale);
        particle.vx *= damping;
        particle.vy *= damping;
        particle.x += particle.vx * frameScale;
        particle.y += particle.vy * frameScale;

        // Reset if consumed
        if (dist < holeSizeRef.current * 0.4) {
          const newP = createParticle(w, h);
          Object.assign(particle, newP);
          return;
        }

        // Draw trail
        if (particle.trail.length > 2) {
          ctx.beginPath();
          ctx.moveTo(particle.trail[0].x, particle.trail[0].y);
          for (let i = 1; i < particle.trail.length; i++) {
            ctx.lineTo(particle.trail[i].x, particle.trail[i].y);
          }
          const alpha = Math.floor(particle.opacity * 30);
          ctx.strokeStyle = particle.color + alpha.toString(16).padStart(2, '0');
          ctx.lineWidth = particle.size * 0.4;
          ctx.stroke();
        }

        // Draw particle
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        const pAlpha = Math.floor(particle.opacity * 255);
        ctx.fillStyle = particle.color + pAlpha.toString(16).padStart(2, '0');
        ctx.fill();
      });

      // Orbiting charge ring appears only after the black hole's sudden reveal.
      if (phaseRef.current === 'forming') {
        const chargeProgress = Math.min(1, Math.max(0, (elapsed - 1.25) / 0.2));
        chargeDots.forEach((dot) => {
          const angle = dot.offset + elapsed * 3.2;
          const radius = minDim * 0.09 * dot.radiusJitter;
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius;
          ctx.beginPath();
          ctx.arc(x, y, 1.6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(114, 210, 203, ${0.7 * chargeProgress})`;
          ctx.fill();
        });
      }

      // Realistic black-hole pass: a thin, asymmetric hot disk around a dark core.
      if (phaseRef.current !== 'logo') {
        const diskRotation = elapsed * (0.2 + spin * 0.32);
        const radius = Math.max(2, holeSizeRef.current);
        const reveal = phaseRef.current === 'forming' ? 0.7 : 1;
        const diskAspect = 0.12 + 0.88 * Math.cos(inclination);
        const lensedArcHeight = 0.24 + 0.58 * Math.sin(inclination);
        const dopplerContrast = Math.sin(inclination);

        ctx.save();
        ctx.translate(cx, cy);
        ctx.globalCompositeOperation = 'lighter';
        ctx.filter = 'blur(0.35px)';

        // A fixed viewing angle keeps Doppler brightening on the approaching side.
        const diskGradient = ctx.createLinearGradient(-radius * 1.8, 0, radius * 1.8, 0);
        diskGradient.addColorStop(0, `rgba(126, 194, 255, ${(0.3 + 0.54 * dopplerContrast) * reveal})`);
        diskGradient.addColorStop(0.18, `rgba(255, 225, 178, ${(0.34 + 0.32 * dopplerContrast) * reveal})`);
        diskGradient.addColorStop(0.42, `rgba(255, 155, 77, ${0.32 * reveal})`);
        diskGradient.addColorStop(0.7, `rgba(255, 111, 51, ${(0.32 - 0.16 * dopplerContrast) * reveal})`);
        diskGradient.addColorStop(1, `rgba(136, 48, 35, ${(0.3 - 0.2 * dopplerContrast) * reveal})`);

        // A soft plasma envelope adds depth without washing out the central shadow.
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.58, radius * 1.58 * diskAspect, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 143, 62, ${0.09 * reveal})`;
        ctx.lineWidth = Math.max(2, radius * 0.14);
        ctx.shadowColor = 'rgba(255, 126, 49, 0.7)';
        ctx.shadowBlur = radius * 0.18;
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.38, radius * 1.38 * diskAspect, 0, 0, Math.PI * 2);
        ctx.strokeStyle = diskGradient;
        ctx.lineWidth = Math.max(1.5, radius * 0.07);
        ctx.stroke();

        // Light from the far side of the disk is lensed into upper and lower humps.
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.28, radius * lensedArcHeight, 0, Math.PI * 1.08, Math.PI * 1.92);
        ctx.strokeStyle = `rgba(255, 190, 137, ${0.32 * reveal * dopplerContrast})`;
        ctx.lineWidth = Math.max(0.8, radius * 0.018);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.28, radius * lensedArcHeight, 0, Math.PI * 0.08, Math.PI * 0.92);
        ctx.strokeStyle = `rgba(255, 166, 111, ${0.2 * reveal * dopplerContrast})`;
        ctx.lineWidth = Math.max(0.7, radius * 0.014);
        ctx.stroke();

        // Turbulent bright knots orbit at different rates, with the approaching side boosted.
        for (let knot = 0; knot < 6; knot++) {
          const orbitRadius = 1.12 + (knot % 3) * 0.12;
          const angularSpeed = 0.82 / Math.sqrt(orbitRadius);
          const angle = diskRotation * angularSpeed + knot * Math.PI / 3;
          const x = Math.cos(angle) * radius * orbitRadius;
          const y = Math.sin(angle) * radius * orbitRadius * diskAspect;
          const dopplerBoost = 1 - 0.5 * dopplerContrast + dopplerContrast * (0.5 + 0.5 * Math.cos(angle - Math.PI));
          const knotAlpha = reveal * (0.22 + 0.42 * dopplerBoost);
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1, radius * 0.018), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 226, 174, ${knotAlpha})`;
          ctx.shadowColor = 'rgba(255, 157, 79, 0.72)';
          ctx.shadowBlur = radius * 0.045;
          ctx.fill();
        }
        ctx.shadowBlur = 0;

        ctx.restore();

        // A restrained warm corona around the lensed shadow, not a solid teal halo.
        const lensGrad = ctx.createRadialGradient(shadowCx, shadowCy, radius * 0.72, shadowCx, shadowCy, radius * 2.8);
        lensGrad.addColorStop(0, 'rgba(255, 190, 126, 0.1)');
        lensGrad.addColorStop(0.22, 'rgba(255, 125, 58, 0.08)');
        lensGrad.addColorStop(0.58, 'rgba(105, 55, 42, 0.025)');
        lensGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(shadowCx, shadowCy, radius * 2.8, 0, Math.PI * 2);
        ctx.fillStyle = lensGrad;
        ctx.fill();

        // The observed shadow is larger than the event horizon and remains absolute black.
        ctx.beginPath();
        const shadowFlattening = 1 - spin * Math.sin(inclination) * 0.035;
        ctx.ellipse(shadowCx, shadowCy, radius * 0.72, radius * 0.72 * shadowFlattening, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();

        const photonAlpha = phaseRef.current === 'forming' ? 0.7 : 0.92;
        [
          { radius: 0.785, alpha: photonAlpha, width: 0.018, blur: 0.07 },
          { radius: 0.855, alpha: photonAlpha * 0.28, width: 0.008, blur: 0.025 },
          { radius: 0.91, alpha: photonAlpha * 0.1, width: 0.004, blur: 0.01 },
        ].forEach((ring) => {
          ctx.beginPath();
          ctx.ellipse(shadowCx, shadowCy, radius * ring.radius, radius * ring.radius * shadowFlattening, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255, 218, 170, ${ring.alpha})`;
          ctx.lineWidth = Math.max(0.55, radius * ring.width);
          ctx.shadowColor = 'rgba(255, 151, 74, 0.65)';
          ctx.shadowBlur = Math.max(0.8, radius * ring.blur);
          ctx.stroke();
        });
        ctx.shadowBlur = 0;

        // The near-side plasma stays in front of the shadow, completing the lensed disk.
        ctx.save();
        ctx.translate(cx, cy);
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.3, radius * 1.3 * diskAspect, 0, Math.PI * 0.1, Math.PI * 0.9);
        ctx.strokeStyle = `rgba(255, 177, 91, ${0.62 * reveal})`;
        ctx.lineWidth = Math.max(1.2, radius * 0.034);
        ctx.shadowColor = 'rgba(255, 173, 82, 0.85)';
        ctx.shadowBlur = radius * 0.08;
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.3, radius * 1.3 * diskAspect, 0, Math.PI * 0.18, Math.PI * 0.82);
        ctx.strokeStyle = `rgba(255, 239, 190, ${0.68 * reveal})`;
        ctx.lineWidth = Math.max(0.7, radius * 0.012);
        ctx.shadowBlur = 0;
        ctx.stroke();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(cx, cy, radius * 0.96, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 182, 139, 0.1)';
        ctx.lineWidth = Math.max(0.4, radius * 0.008);
        ctx.stroke();
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animate(previousFrameTime);

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(animationRef.current);
      finishSafely();
    };
    canvas.addEventListener('contextlost', handleContextLost);

    return () => {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('contextlost', handleContextLost);
      cancelAnimationFrame(animationRef.current);
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
        completionTimerRef.current = null;
      }
    };
  }, [createParticle]);

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
      className={`preloader-overlay${isExiting ? ' preloader-overlay--exiting' : ''} select-none`}
    >
      {/* Particle canvas - fills entire viewport */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
      />

      {/* Shockwave fires the moment the black hole appears */}
      <AnimatePresence>
        {shockwave && (
          <motion.div
            initial={{ opacity: 0.6, scale: 0.3 }}
            animate={{ opacity: 0, scale: 2.6 }}
            transition={{ duration: 1.1, ease: 'easeOut' }}
            onAnimationComplete={() => setShockwave(false)}
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
          >
            <div
              className="rounded-full border"
              style={{
                width: '40vmin',
                height: '40vmin',
                borderColor: 'rgba(114, 210, 203, 0.5)',
                borderWidth: 1.5,
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Logo appears first, then is consumed by the black hole */}
      <div
        ref={logoTransformRef}
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{
          transform: 'scale(1)',
          opacity: 1,
          willChange: 'transform, opacity, filter',
        }}
      >
        <motion.div
          className="flex flex-col items-center gap-3 sm:gap-5"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* A single controlled halo assembles the mark before the black hole arrives. */}
          <div className="relative w-24 h-24 sm:w-32 sm:h-32">
            <div className="absolute inset-2 bg-brand-500/35 blur-3xl" />
            <motion.div
              className="relative z-10 w-full h-full flex items-center justify-center"
              initial={{ opacity: 0, scale: 0.5, filter: 'blur(14px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.85, delay: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              <img src="/brand/logo-icon.png" alt="Hopr" className="w-full h-full object-contain drop-shadow-[0_0_24px_rgba(63,176,170,0.7)]" />
            </motion.div>
          </div>

          <motion.h1
            className="text-2xl sm:text-4xl font-bold gradient-text"
            initial={{ opacity: 0, y: 10, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ delay: 0.48, duration: 0.55, ease: 'easeOut' }}
          >
            hopr
          </motion.h1>
        </motion.div>
      </div>

      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(ellipse at center, transparent 20%, rgba(0,0,0,0.5) 100%)'
      }} />
    </motion.div>
  );
}
