// gateway/middlewares/audit-middleware.js

import { buildEntry, writeEntry } from "../service/audit-service.js";

/**
 * Append one JSON line per API request after the response finishes, so the
 * status code and duration are recorded. Mounted before auth on purpose:
 * rejected calls (401/429/…) are the most interesting audit trail.
 */
function auditMiddleware(req, res, next) {
  const started = Date.now();

  res.on("finish", () => {
    void writeEntry(buildEntry(req, res, Date.now() - started));
  });

  next();
}

export { auditMiddleware };
