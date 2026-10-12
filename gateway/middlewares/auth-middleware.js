// gateway/middlewares/auth-middleware.js

import { timingSafeEqual } from "node:crypto";
import { ResponseError } from "../error/response-error.js";
import { getGatewayToken } from "../auth/token.js";

function matches(presented, expected) {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}

async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const { token: expected } = await getGatewayToken();

    if (!presented || !matches(presented, expected)) {
      throw new ResponseError(
        401,
        "Missing or invalid gateway token. Provide it as: Authorization: Bearer <token>.",
      );
    }

    next();
  } catch (error) {
    next(error);
  }
}

export { authMiddleware };
