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
    res.status(200).send(sessionService.getConversation(session_id));
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
    const { prompt } = req.body ?? {};
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new ResponseError(400, "prompt must be a non-empty string.");
    }
    return res.status(200).send(sessionService.createSession(prompt));
  } catch (error) {
    next(error);
  }
}

function renameSession(req, res, next) {
  try {
    const { session_id } = req.params;
    requireSessionId(session_id);
    const { name } = req.body ?? {};
    return res.status(200).send(sessionService.renameSession(session_id, name));
  } catch (error) {
    next(error);
  }
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

export default { listSession, getConversation, getSessionInfo, createSession, renameSession, deleteSession };
