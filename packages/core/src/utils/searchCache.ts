/**
 * @license
 * Copyright 2025 Kolosal
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LRU Cache for search results to avoid repeated API calls
 */
export interface CacheEntry<T> {
  value: T;
  timestamp: number;
  expiresAt: number;
}

export class SearchCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private defaultTtlMs: number;

  constructor(options?: { maxSize?: number; ttlMs?: number }) {
    this.maxSize = options?.maxSize ?? 100;
    this.defaultTtlMs = options?.ttlMs ?? 5 * 60 * 1000; // 5 minutes default
  }

  /**
   * Get a cached value if it exists and hasn't expired
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end for LRU
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set a value in the cache
   */
  set(key: string, value: T, ttlMs?: number): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    const now = Date.now();
    this.cache.set(key, {
      value,
      timestamp: now,
      expiresAt: now + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /**
   * Check if a key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a specific key
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }

  /**
   * Generate a cache key from search parameters
   */
  static generateKey(query: string, options?: Record<string, unknown>): string {
    const normalizedQuery = query.toLowerCase().trim();
    const optionsStr = options ? JSON.stringify(options) : '';
    return `${normalizedQuery}:${optionsStr}`;
  }
}

// Global search cache instance
export const webSearchCache = new SearchCache<{
  answer?: string;
  results: Array<{ title: string; url: string; content?: string }>;
}>({
  maxSize: 50,
  ttlMs: 10 * 60 * 1000, // 10 minute cache for search results
});

// Web content cache (for fetched pages)
export const webContentCache = new SearchCache<string>({
  maxSize: 30,
  ttlMs: 15 * 60 * 1000, // 15 minute cache for page content
});
