import { useCallback, useRef } from 'react';

interface RateLimitOptions {
  maxRequests: number; // Maximum requests allowed
  windowMs: number; // Time window in milliseconds
  onLimitReached?: () => void;
}

export function useRateLimiter({ maxRequests, windowMs, onLimitReached }: RateLimitOptions) {
  const requestsRef = useRef<number[]>([]);

  const canMakeRequest = useCallback((): boolean => {
    const now = Date.now();
    const windowStart = now - windowMs;

    // Remove old requests outside the window
    requestsRef.current = requestsRef.current.filter(time => time > windowStart);

    // Check if we can make a request
    if (requestsRef.current.length >= maxRequests) {
      onLimitReached?.();
      return false;
    }

    // Add this request
    requestsRef.current.push(now);
    return true;
  }, [maxRequests, windowMs, onLimitReached]);

  const reset = useCallback(() => {
    requestsRef.current = [];
  }, []);

  const getRemainingRequests = useCallback((): number => {
    const now = Date.now();
    const windowStart = now - windowMs;
    const activeRequests = requestsRef.current.filter(time => time > windowStart);
    return Math.max(0, maxRequests - activeRequests.length);
  }, [maxRequests, windowMs]);

  const getTimeUntilNextRequest = useCallback((): number => {
    if (requestsRef.current.length < maxRequests) return 0;
    
    const oldestRequest = requestsRef.current[0];
    const timeUntilExpiry = oldestRequest + windowMs - Date.now();
    return Math.max(0, timeUntilExpiry);
  }, [maxRequests, windowMs]);

  return {
    canMakeRequest,
    reset,
    getRemainingRequests,
    getTimeUntilNextRequest,
  };
}

// Debounce hook for search inputs
export function useDebounce<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): (...args: Parameters<T>) => void {
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        callback(...args);
      }, delay);
    },
    [callback, delay]
  );
}

// Throttle hook for rapid actions
export function useThrottle<T extends (...args: any[]) => any>(
  callback: T,
  limit: number
): T {
  const lastRunRef = useRef<number>(0);

  return useCallback(
    ((...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastRunRef.current >= limit) {
        callback(...args);
        lastRunRef.current = now;
      }
    }) as T,
    [callback, limit]
  );
}
