// gateway/middleware/error-middleware.js

import { ResponseError } from "../error/response-error.js";

async function errorMiddleware(err, req, res, next) {
  if (!err) {
    return;
  }

  if (err instanceof ResponseError) {
    res.status
      .json({
        error: err.message,
      })
      .end();
  } else {
    res.status(500).json({
      error: err.message,
    });
  }
}

export { errorMiddleware };
