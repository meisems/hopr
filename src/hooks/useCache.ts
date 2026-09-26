import { useState, useEffect, useCallback } from 'react';

interface CacheOptions {
  key: string;
  ttl?: number; // Time to live in milliseconds
  storage?: 'localStorage' | 'sessionStorage';
}

export function useCache<T>({ key, ttl = 5 * 60 * 1000, storage = 'localStorage' }: CacheOptions) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const storageObj = storage === 'localStorage' ? localStorage : sessionStorage;

  const get = useCallback((): T | null => {
    try {
      const item = storageObj.getItem(`hopr-cache-${key}`);
      if (!item) return null;

      const { value, timestamp } = JSON.parse(item);
      if (Date.now() - timestamp > ttl) {
        storageObj.removeItem(`hopr-cache-${key}`);
        return null;
      }

      return value;
    } catch {
      return null;
    }
  }, [key, ttl, storageObj]);

  const set = useCallback((value: T) => {
    try {
      storageObj.setItem(
        `hopr-cache-${key}`,
        JSON.stringify({ value, timestamp: Date.now() })
      );
      setData(value);
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }, [key, storageObj]);

  const remove = useCallback(() => {
    try {
      storageObj.removeItem(`hopr-cache-${key}`);
      setData(null);
    } catch (error) {
      console.error('Cache remove error:', error);
    }
  }, [key, storageObj]);

  useEffect(() => {
    const cached = get();
    if (cached) setData(cached);
  }, [get]);

  return { data, setData: set, isLoading, remove, get };
}
