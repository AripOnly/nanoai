// gateway/middlewares/rate-limit-middleware.js

import { ResponseError } from "../error/response-error.js";

/**
 * Fixed-window rate limiter (in-memory, per IP). Enough for a single-user,
 * single-process gateway: it stops runaway loops and token abuse while
 * normal use never comes close to the caps.
 */
export function rateLimit({ windowMs, max, scope = "global" }) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new Error("windowMs must be a positive integer.");
  }

  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("max must be a positive integer.");
  }

  const windowSeconds = Math.round(windowMs / 1000);
  const hits = new Map();

  return (req, res, next) => {
    try {
      const now = Date.now();
      const key = `${scope}:${req.ip}`;
      let entry = hits.get(key);

      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }

      entry.count += 1;

      if (hits.size > 10000) {
        for (const [storedKey, stored] of hits) {
          if (stored.resetAt <= now) {
            hits.delete(storedKey);
          }
        }
      }

      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader(
        "X-RateLimit-Remaining",
        String(Math.max(0, max - entry.count)),
      );

      if (entry.count > max) {
        res.setHeader("Retry-After", String(retryAfter));
        throw new ResponseError(
          429,
          `Rate limit exceeded: max ${max} requests per ${windowSeconds}s. Retry in ${retryAfter}s.`,
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
