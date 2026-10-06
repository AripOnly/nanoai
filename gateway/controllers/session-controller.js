// gateway/controllers/session-controller.js

import sessionService from "../service/session-service.js";

function listSession(req, res, next) {
  try {
    res.status(200).send(sessionService.listSession());
  } catch (error) {
    next(error);
  }
}

function getHistory(req, res, next) {
  try {
    const { session_id } = req.params;
    res.status(200).send(sessionService.getHistory(session_id));
  } catch (error) {
    next(error);
  }
}

function getSessionInfo(req, res, next) {
  try {
    const { session_id } = req.params;
    res.status(200).send(sessionService.getSessionInfo(session_id));
  } catch (error) {
    next(error);
  }
}

function createSession(req, res, next) {
  try {
    const { prompt } = req.body;
    return res.status(200).send(sessionService.createSession(prompt));
  } catch (error) {
    next(error);
  }
}

export default { listSession, getHistory, getSessionInfo, createSession };
