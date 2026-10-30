/**
 * Server-side in-memory sliding window rate limiter.
 * Protects authentication, safe-key verification, and password reset endpoints
 * against brute-force attacks and credential stuffing.
 */

interface RateLimitBucket {
  count: number;
  resetAt: number;
  blockedUntil?: number;
}

class RateLimiter {
  private buckets = new Map<string, RateLimitBucket>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Automatically prune expired buckets every 5 minutes to prevent memory leaks
    if (typeof setInterval !== "undefined") {
      this.cleanupInterval = setInterval(() => this.prune(), 5 * 60 * 1000);
      if (this.cleanupInterval.unref) {
        this.cleanupInterval.unref();
      }
    }
  }

  private prune() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now > bucket.resetAt && (!bucket.blockedUntil || now > bucket.blockedUntil)) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Check if an action is allowed under the rate limit.
   */
  public check(
    key: string,
    maxAttempts: number,
    windowMs: number,
    blockDurationMs: number = windowMs
  ): { allowed: boolean; remaining: number; retryAfterSeconds?: number } {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket) {
      return { allowed: true, remaining: maxAttempts };
    }

    if (bucket.blockedUntil && now < bucket.blockedUntil) {
      const retryAfterSeconds = Math.ceil((bucket.blockedUntil - now) / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    if (now > bucket.resetAt) {
      this.buckets.delete(key);
      return { allowed: true, remaining: maxAttempts };
    }

    if (bucket.count >= maxAttempts) {
      // Trigger lockout block
      bucket.blockedUntil = now + blockDurationMs;
      const retryAfterSeconds = Math.ceil(blockDurationMs / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    return { allowed: true, remaining: Math.max(0, maxAttempts - bucket.count) };
  }

  /**
   * Increment attempt counter on failed authentication.
   */
  public recordFailure(
    key: string,
    maxAttempts: number,
    windowMs: number,
    blockDurationMs: number = windowMs
  ): { blocked: boolean; retryAfterSeconds?: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
      return { blocked: false };
    }

    bucket.count += 1;

    if (bucket.count >= maxAttempts) {
      bucket.blockedUntil = now + blockDurationMs;
      return { blocked: true, retryAfterSeconds: Math.ceil(blockDurationMs / 1000) };
    }

    return { blocked: false };
  }

  /**
   * Reset rate limit bucket on successful authentication.
   */
  public reset(key: string) {
    this.buckets.delete(key);
  }

  /**
   * Clear all active rate limit buckets (useful for administrative reset or test runs).
   */
  public clearAll() {
    this.buckets.clear();
  }
}

// Global singleton instance across route handlers in Next.js server runtime
declare global {
  var __authRateLimiter: RateLimiter | undefined;
}

export const authRateLimiter = global.__authRateLimiter || new RateLimiter();
if (process.env.NODE_ENV !== "production") {
  global.__authRateLimiter = authRateLimiter;
}
