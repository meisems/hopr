import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface SplashScreenProps {
  onComplete: () => void;
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

export default function SplashScreen({ onComplete }: SplashScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationRef = useRef<number>(0);
  const startTimeRef = useRef(Date.now());
  const phaseRef = useRef<'logo' | 'forming' | 'pulling' | 'consuming' | 'gone'>('logo');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const [phase, setPhase] = useState<'logo' | 'forming' | 'pulling' | 'consuming' | 'gone'>('logo');
  const [logoScale, setLogoScale] = useState(1);
  const [logoOpacity, setLogoOpacity] = useState(1);
  const holeSizeRef = useRef(0);
  const [holeSize, setHoleSize] = useState(0);
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

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    const particleCount = Math.min(320, Math.max(150, Math.floor((w * h) / 4800)));
    particlesRef.current = Array.from({ length: particleCount }, () =>
      createParticle(w, h)
    );

    // Pre-generate static star positions
    const stars = Array.from({ length: 260 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      size: Math.random() < 0.92 ? Math.random() * 1.1 + 0.2 : Math.random() * 2 + 1,
      twinkle: Math.random() * Math.PI * 2,
      warmth: Math.random(),
    }));

    // Orbiting "charge" ring shown while the mark is forming
    const chargeDots = Array.from({ length: 22 }, (_, i) => ({
      offset: (i / 14) * Math.PI * 2,
      radiusJitter: Math.random() * 0.15 + 0.9,
    }));

    let shockwaveFired = false;

    const animate = () => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      const cx = w / 2;
      const cy = h / 2;
      const minDim = Math.min(w, h);

      // The logo gets a clean moment on its own before the black hole arrives.
      if (elapsed > 1.25 && phaseRef.current === 'logo') {
        phaseRef.current = 'forming';
        setPhase('forming');
        shockwaveFired = true;
        setShockwave(true);
      }
      if (elapsed > 1.5 && phaseRef.current === 'forming') {
        phaseRef.current = 'pulling';
        setPhase('pulling');
      }
      if (elapsed > 1.72 && phaseRef.current === 'pulling') {
        phaseRef.current = 'consuming';
        setPhase('consuming');
      }
      if (elapsed > 3.15 && phaseRef.current === 'consuming') {
        phaseRef.current = 'gone';
        setPhase('gone');
        setTimeout(() => onCompleteRef.current(), 360);
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
      holeSizeRef.current += (targetHoleSize - holeSizeRef.current) * holeEase;
      setHoleSize(holeSizeRef.current);

      // Update logo transform
      if (phaseRef.current === 'pulling') {
        setLogoScale(prev => Math.max(0.35, prev * 0.96));
        setLogoOpacity(prev => Math.max(0.2, prev - 0.018));
      } else if (phaseRef.current === 'consuming') {
        setLogoScale(prev => Math.max(0.01, prev * 0.97));
        setLogoOpacity(prev => Math.max(0, prev - 0.012));
      } else if (phaseRef.current === 'gone') {
        setLogoScale(0);
        setLogoOpacity(0);
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
      stars.forEach((star) => {
        const dx = star.x - cx;
        const dy = star.y - cy;
        const betaPixels = Math.sqrt(dx * dx + dy * dy);
        const beta = betaPixels / einsteinRadius;
        const root = Math.sqrt(beta * beta + 4);
        const primaryRadius = einsteinRadius * (beta + root) * 0.5;
        const secondaryRadius = einsteinRadius * (root - beta) * 0.5;
        const magnification = Math.min(3.2, 0.5 + (beta * beta + 2) / (2 * Math.max(beta, 0.06) * root));
        const angle = betaPixels > 0 ? Math.atan2(dy, dx) : 0;
        const twinkle = 0.28 + Math.sin(elapsed * (1.4 + star.warmth * 2) + star.twinkle) * 0.24;
        const color = star.warmth > 0.82 ? '255, 225, 180' : '218, 242, 255';
        const drawImage = (imageRadius: number, imageAngle: number, alpha: number, sizeScale: number) => {
          if (imageRadius < holeSizeRef.current * 0.76 || alpha <= 0.01) return;
          const x = cx + Math.cos(imageAngle) * imageRadius;
          const y = cy + Math.sin(imageAngle) * imageRadius;
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

        const primaryX = cx + Math.cos(angle) * primaryRadius;
        const primaryY = cy + Math.sin(angle) * primaryRadius;
        const blendedX = star.x + (primaryX - star.x) * lensMix;
        const blendedY = star.y + (primaryY - star.y) * lensMix;
        const blendedRadius = Math.sqrt((blendedX - cx) ** 2 + (blendedY - cy) ** 2);
        const blendedAngle = Math.atan2(blendedY - cy, blendedX - cx);
        drawImage(blendedRadius, blendedAngle, twinkle * (1 - lensMix * 0.18) * Math.sqrt(magnification), 1 + lensMix * (Math.sqrt(magnification) - 1));

        // The fainter, mirrored image makes close alignments resolve into luminous arcs.
        if (beta < 3.6 && lensMix > 0.04) {
          const secondaryMagnification = Math.max(0, magnification - 1);
          drawImage(secondaryRadius, angle + Math.PI, twinkle * lensMix * Math.min(0.42, secondaryMagnification * 0.2), 0.8 + Math.sqrt(secondaryMagnification) * 0.2);
        }
      });

      // Update and draw particles
      particlesRef.current.forEach((particle) => {
        // Trail
        particle.trail.push({ x: particle.x, y: particle.y });
        if (particle.trail.length > 10) particle.trail.shift();

        // Gravity toward center
        const dx = cx - particle.x;
        const dy = cy - particle.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 1) {
          const force = (gravity * 80) / (dist * dist + 200);
          particle.vx += (dx / dist) * force;
          particle.vy += (dy / dist) * force;

          // Orbital component
          const orbForce = gravity * 0.15;
          particle.vx += (-dy / dist) * orbForce * 0.08;
          particle.vy += (dx / dist) * orbForce * 0.08;
        }

        // Velocity damping
        particle.vx *= 0.985;
        particle.vy *= 0.985;
        particle.x += particle.vx;
        particle.y += particle.vy;

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
        const diskRotation = elapsed * 0.32;
        const radius = Math.max(2, holeSizeRef.current);
        const reveal = phaseRef.current === 'forming' ? 0.7 : 1;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(diskRotation);
        ctx.globalCompositeOperation = 'lighter';
        ctx.filter = 'blur(0.35px)';

        // Perspective-flattened plasma disk, Doppler-brightened on its approaching side.
        const diskGradient = ctx.createLinearGradient(-radius * 1.8, 0, radius * 1.8, 0);
        diskGradient.addColorStop(0, `rgba(42, 108, 125, ${0.08 * reveal})`);
        diskGradient.addColorStop(0.24, `rgba(255, 127, 55, ${0.2 * reveal})`);
        diskGradient.addColorStop(0.48, `rgba(255, 184, 94, ${0.48 * reveal})`);
        diskGradient.addColorStop(0.68, `rgba(255, 246, 211, ${0.98 * reveal})`);
        diskGradient.addColorStop(0.82, `rgba(255, 143, 55, ${0.62 * reveal})`);
        diskGradient.addColorStop(1, `rgba(48, 117, 126, ${0.1 * reveal})`);

        // A soft plasma envelope adds depth without washing out the central shadow.
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.58, radius * 0.4, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 143, 62, ${0.09 * reveal})`;
        ctx.lineWidth = Math.max(2, radius * 0.14);
        ctx.shadowColor = 'rgba(255, 126, 49, 0.7)';
        ctx.shadowBlur = radius * 0.18;
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.38, radius * 0.28, 0, 0, Math.PI * 2);
        ctx.strokeStyle = diskGradient;
        ctx.lineWidth = Math.max(1.5, radius * 0.07);
        ctx.stroke();

        // The far side of the disk bends over the top of the shadow.
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.3, radius * 0.34, 0, Math.PI * 1.08, Math.PI * 1.92);
        ctx.strokeStyle = `rgba(255, 182, 105, ${0.38 * reveal})`;
        ctx.lineWidth = Math.max(1, radius * 0.028);
        ctx.stroke();

        ctx.restore();

        // Broad lensing glow fades smoothly into the star field.
        const lensGrad = ctx.createRadialGradient(cx, cy, radius * 0.72, cx, cy, radius * 2.8);
        lensGrad.addColorStop(0, 'rgba(255, 206, 126, 0.12)');
        lensGrad.addColorStop(0.22, 'rgba(63, 176, 170, 0.16)');
        lensGrad.addColorStop(0.58, 'rgba(24, 70, 78, 0.07)');
        lensGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 2.8, 0, Math.PI * 2);
        ctx.fillStyle = lensGrad;
        ctx.fill();

        // Event horizon and thin photon ring: the shadow remains absolute black.
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 0.72, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();

        const photonAlpha = phaseRef.current === 'forming' ? 0.7 : 0.92;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * 0.82, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 224, 160, ${photonAlpha})`;
        ctx.lineWidth = Math.max(1, radius * 0.024);
        ctx.shadowColor = 'rgba(255, 160, 67, 0.8)';
        ctx.shadowBlur = Math.max(3, radius * 0.09);
        ctx.stroke();
        ctx.shadowBlur = 0;

        // The near-side plasma stays in front of the shadow, completing the lensed disk.
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(diskRotation);
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.3, radius * 0.34, 0, Math.PI * 0.1, Math.PI * 0.9);
        ctx.strokeStyle = `rgba(255, 177, 91, ${0.62 * reveal})`;
        ctx.lineWidth = Math.max(1.2, radius * 0.034);
        ctx.shadowColor = 'rgba(255, 173, 82, 0.85)';
        ctx.shadowBlur = radius * 0.08;
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(0, 0, radius * 1.3, radius * 0.34, 0, Math.PI * 0.18, Math.PI * 0.82);
        ctx.strokeStyle = `rgba(255, 239, 190, ${0.68 * reveal})`;
        ctx.lineWidth = Math.max(0.7, radius * 0.012);
        ctx.shadowBlur = 0;
        ctx.stroke();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(cx, cy, radius * 0.96, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(108, 203, 198, 0.28)';
        ctx.lineWidth = Math.max(0.5, radius * 0.018);
        ctx.stroke();
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationRef.current);
    };
  }, [createParticle]);

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
      className="fixed inset-0 z-[100] bg-black overflow-hidden select-none"
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
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{
          transform: `scale(${logoScale})`,
          opacity: logoOpacity,
          filter: phase === 'consuming' ? `blur(${(1 - logoScale) * 8}px)` : 'none',
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
