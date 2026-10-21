// gateway/controllers/session-controller.js

import sessionService from "../service/session-service.js";
import { ResponseError } from "../error/response-error.js";

function requireSessionId(session_id) {
  if (typeof session_id !== "string" || session_id.trim() === "") {
    throw new ResponseError(400, "session_id must be a non-empty string.");
  }
}

function listSession(req, res, next) {
  try {
    res.status(200).send(sessionService.listSession());
  } catch (error) {
    next(error);
  }
}

function getConversation(req, res, next) {
  try {
    const { session_id } = req.params;
    requireSessionId(session_id);
    res.status(200).send(
      sessionService.getConversation(session_id, {
        limit: req.query?.limit,
        before: req.query?.before,
      }),
    );
  } catch (error) {
    next(error);
  }
}

function listTurns(req, res, next) {
  try {
    const { session_id } = req.params;
    requireSessionId(session_id);
    res.status(200).send(
      sessionService.listTurns(session_id, {
        limit: req.query?.limit,
        before: req.query?.before,
      }),
    );
  } catch (error) {
    next(error);
  }
}

function getSessionInfo(req, res, next) {
  try {
    const { session_id } = req.params;
    requireSessionId(session_id);
    res.status(200).send(sessionService.getSessionInfo(session_id));
  } catch (error) {
    next(error);
  }
}

function createSession(req, res, next) {
  try {
    const body = req.body ?? {};
    return res.status(200).send(sessionService.createSession(body));
  } catch (error) {
    next(error);
  }
}

function resolveSession(req, res, next) {
  try {
    return res.status(200).send(sessionService.resolveSession(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

function updateSession(req, res, next) {
  try {
    const { session_id } = req.params;
    requireSessionId(session_id);
    return res
      .status(200)
      .send(sessionService.updateSession(session_id, req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

function renameSession(req, res, next) {
  return updateSession(req, res, next);
}

function deleteSession(req, res, next) {
  try {
    const { session_id } = req.params;
    requireSessionId(session_id);
    return res.status(200).send(sessionService.deleteSession(session_id));
  } catch (error) {
    next(error);
  }
}

export default {
  listSession,
  getConversation,
  listTurns,
  getSessionInfo,
  createSession,
  resolveSession,
  updateSession,
  renameSession,
  deleteSession,
};
