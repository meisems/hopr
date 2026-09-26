import { CSSProperties, memo, useEffect, useRef } from 'react';

interface SplashScreenProps {
  isExiting: boolean;
  onExitStart: () => void;
  onExitComplete: () => void;
  spin: number;
  inclination: number;
}

const PRELOADER_DURATION_MS = 2500;

function SplashScreen({ isExiting, onExitStart, onExitComplete, spin, inclination }: SplashScreenProps) {
  const exitStartedRef = useRef(false);
  const completedRef = useRef(false);
  const onExitStartRef = useRef(onExitStart);
  const onExitCompleteRef = useRef(onExitComplete);
  onExitStartRef.current = onExitStart;
  onExitCompleteRef.current = onExitComplete;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (exitStartedRef.current) return;
      exitStartedRef.current = true;
      onExitStartRef.current();
    }, PRELOADER_DURATION_MS);

    return () => window.clearTimeout(timer);
  }, []);

  const sceneStyle = {
    '--preloader-inclination': `${Math.max(0, Math.min(90, inclination)) * 0.18}deg`,
    '--preloader-speed': `${Math.max(2.4, 4.6 - spin * 1.4)}s`,
  } as CSSProperties;

  return (
    <div
      className={`preloader-overlay${isExiting ? ' preloader-overlay--exiting' : ''}`}
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === 'opacity' &&
          isExiting &&
          !completedRef.current
        ) {
          completedRef.current = true;
          onExitCompleteRef.current();
        }
      }}
      aria-label="Loading hopr"
    >
      <div className="preloader-scene" style={sceneStyle}>
        <div className="preloader-stars" aria-hidden="true" />
        <div className="preloader-ring preloader-ring--outer" aria-hidden="true" />
        <div className="preloader-ring preloader-ring--middle" aria-hidden="true" />
        <div className="preloader-ring preloader-ring--inner" aria-hidden="true" />
        <div className="preloader-core">
          <img src="/brand/logo-icon.png" alt="Hopr" />
          <span>hopr</span>
        </div>
      </div>
    </div>
  );
}

export default memo(SplashScreen);
