import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap } from 'lucide-react';

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

const COLORS = ['#a855f7', '#6366f1', '#3b82f6', '#8b5cf6', '#7c3aed', '#4f46e5', '#2563eb', '#c084fc'];

export default function SplashScreen({ onComplete }: SplashScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationRef = useRef<number>(0);
  const startTimeRef = useRef(Date.now());
  const phaseRef = useRef<'forming' | 'pulling' | 'consuming' | 'gone'>('forming');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const [phase, setPhase] = useState<'forming' | 'pulling' | 'consuming' | 'gone'>('forming');
  const [logoScale, setLogoScale] = useState(1);
  const [logoOpacity, setLogoOpacity] = useState(1);
  const holeSizeRef = useRef(0);
  const [holeSize, setHoleSize] = useState(0);

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
    const particleCount = Math.min(250, Math.floor((w * h) / 6000));
    particlesRef.current = Array.from({ length: particleCount }, () =>
      createParticle(w, h)
    );

    // Pre-generate static star positions
    const stars = Array.from({ length: 80 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      size: Math.random() * 1.2 + 0.3,
      twinkle: Math.random() * Math.PI * 2,
    }));

    const animate = () => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      const cx = w / 2;
      const cy = h / 2;
      const minDim = Math.min(w, h);

      // Phase transitions
      if (elapsed > 0.8 && phaseRef.current === 'forming') {
        phaseRef.current = 'pulling';
        setPhase('pulling');
      }
      if (elapsed > 2.8 && phaseRef.current === 'pulling') {
        phaseRef.current = 'consuming';
        setPhase('consuming');
      }
      if (elapsed > 4.5 && phaseRef.current === 'consuming') {
        phaseRef.current = 'gone';
        setPhase('gone');
        setTimeout(() => onCompleteRef.current(), 600);
        cancelAnimationFrame(animationRef.current);
        return;
      }

      // Update hole size
      const targetHoleSize = phaseRef.current === 'forming' ? minDim * 0.04 :
        phaseRef.current === 'pulling' ? minDim * 0.14 :
        phaseRef.current === 'consuming' ? minDim * 0.38 :
        minDim * 0.55;
      holeSizeRef.current += (targetHoleSize - holeSizeRef.current) * 0.04;
      setHoleSize(holeSizeRef.current);

      // Update logo transform
      if (phaseRef.current === 'consuming') {
        setLogoScale(prev => Math.max(0.01, prev * 0.97));
        setLogoOpacity(prev => Math.max(0, prev - 0.012));
      } else if (phaseRef.current === 'gone') {
        setLogoScale(0);
        setLogoOpacity(0);
      }

      // Gravity strength
      const gravity = phaseRef.current === 'forming' ? 0.4 :
        phaseRef.current === 'pulling' ? 2.0 :
        phaseRef.current === 'consuming' ? 5.0 : 10.0;

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Draw static stars
      stars.forEach((star) => {
        const dist = Math.sqrt((star.x - cx) ** 2 + (star.y - cy) ** 2);
        if (dist > holeSizeRef.current * 1.8) {
          const twinkle = 0.3 + Math.sin(elapsed * 2 + star.twinkle) * 0.3;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 255, 255, ${twinkle})`;
          ctx.fill();
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

      // Accretion disk
      const diskRotation = elapsed * 0.4;
      for (let ring = 0; ring < 6; ring++) {
        const ringRadius = holeSizeRef.current * (1.15 + ring * 0.25);
        const ringOpacity = (0.2 - ring * 0.03) * (phaseRef.current === 'forming' ? 0.5 : 1);
        
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(diskRotation + ring * 0.4);
        ctx.scale(1, 0.25 + Math.sin(elapsed + ring) * 0.05);
        
        ctx.beginPath();
        ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${140 + ring * 15}, ${70 + ring * 10}, ${220 - ring * 10}, ${ringOpacity})`;
        ctx.lineWidth = 2 + ring * 0.5;
        ctx.stroke();
        ctx.restore();
      }

      // Gravitational lensing glow
      const lensGrad = ctx.createRadialGradient(cx, cy, holeSizeRef.current * 0.85, cx, cy, holeSizeRef.current * 1.6);
      lensGrad.addColorStop(0, 'rgba(168, 85, 247, 0.25)');
      lensGrad.addColorStop(0.4, 'rgba(99, 102, 241, 0.1)');
      lensGrad.addColorStop(0.7, 'rgba(59, 130, 246, 0.03)');
      lensGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      
      ctx.beginPath();
      ctx.arc(cx, cy, holeSizeRef.current * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = lensGrad;
      ctx.fill();

      // Event horizon
      const holeGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, holeSizeRef.current * 1.1);
      holeGrad.addColorStop(0, 'rgba(0, 0, 0, 1)');
      holeGrad.addColorStop(0.75, 'rgba(0, 0, 0, 1)');
      holeGrad.addColorStop(0.92, 'rgba(0, 0, 0, 0.98)');
      holeGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      
      ctx.beginPath();
      ctx.arc(cx, cy, holeSizeRef.current * 1.1, 0, Math.PI * 2);
      ctx.fillStyle = holeGrad;
      ctx.fill();

      // Photon ring
      ctx.beginPath();
      ctx.arc(cx, cy, holeSizeRef.current * 0.98, 0, Math.PI * 2);
      const ringAlpha = 0.4 + Math.sin(elapsed * 4) * 0.15;
      ctx.strokeStyle = `rgba(200, 150, 255, ${ringAlpha})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Secondary photon ring
      ctx.beginPath();
      ctx.arc(cx, cy, holeSizeRef.current * 1.05, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(130, 100, 220, ${ringAlpha * 0.5})`;
      ctx.lineWidth = 1;
      ctx.stroke();

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

      {/* Logo being consumed by the black hole */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{
          transform: `scale(${logoScale})`,
          opacity: logoOpacity,
          filter: phase === 'consuming' ? `blur(${(1 - logoScale) * 8}px)` : 'none',
        }}
      >
        <div className="flex flex-col items-center gap-3 sm:gap-5">
          {/* Logo icon */}
          <div className="relative">
            <div className="w-16 h-16 sm:w-24 sm:h-24 bg-gradient-to-br from-purple-500 to-blue-600 rounded-2xl sm:rounded-3xl flex items-center justify-center shadow-2xl shadow-purple-500/40">
              <Zap className="w-8 h-8 sm:w-12 sm:h-12 text-white" />
            </div>
            {/* Glow */}
            <div className="absolute inset-0 bg-gradient-to-br from-purple-500 to-blue-600 rounded-2xl sm:rounded-3xl blur-2xl opacity-60" />
          </div>
          
          {/* Logo text */}
          <div className="text-center">
            <h1 className="text-2xl sm:text-4xl font-bold bg-gradient-to-r from-purple-400 via-blue-400 to-purple-400 bg-clip-text text-transparent">
              OmniSwap
            </h1>
            <p className="text-xs sm:text-base text-gray-400 mt-1 tracking-widest uppercase">
              Cross-Chain Trading
            </p>
          </div>
        </div>
      </div>

      {/* Loading text at bottom */}
      <AnimatePresence>
        {phase !== 'gone' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ delay: 0.8 }}
            className="absolute bottom-6 sm:bottom-12 left-0 right-0 flex flex-col items-center gap-2 sm:gap-3"
          >
            <div className="flex gap-1.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <motion.div
                  key={i}
                  className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-purple-400 rounded-full"
                  animate={{
                    scale: [1, 1.8, 1],
                    opacity: [0.3, 1, 0.3],
                  }}
                  transition={{
                    duration: 1.2,
                    repeat: Infinity,
                    delay: i * 0.15,
                  }}
                />
              ))}
            </div>
            <p className="text-[10px] sm:text-sm text-gray-500 tracking-wide text-center px-4">
              {phase === 'forming' && 'Initializing cross-chain engine...'}
              {phase === 'pulling' && 'Connecting to LI.FI protocol...'}
              {phase === 'consuming' && 'Loading trading interface...'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(ellipse at center, transparent 20%, rgba(0,0,0,0.5) 100%)'
      }} />
    </motion.div>
  );
}
