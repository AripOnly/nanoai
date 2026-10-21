// gateway/controllers/skill-controller.js
//
// Thin HTTP door for the read-only skill registry. Errors are translated by the
// shared middleware; this controller only sets revision headers.

import { createSkillService } from "../service/skill-service.js";

function service(req) {
  return createSkillService(req.app.locals.skills);
}

function headers(req, res) {
  const registry = req.app.locals.skills;
  const snapshot = registry?.snapshot?.();
  if (snapshot) {
    res.set("X-Skills-Revision", String(snapshot.revision));
    res.set("X-Skills-Error", snapshot.lastError ?? "");
  }
}

async function listSkills(req, res, next) {
  try {
    headers(req, res);
    const snapshot = req.app.locals.skills?.snapshot?.();
    res.status(200).send({
      revision: snapshot?.revision ?? null,
      lastError: snapshot?.lastError ?? null,
      skills: service(req).list(),
    });
  } catch (error) {
    next(error);
  }
}

async function reloadSkills(req, res, next) {
  try {
    const result = await service(req).reload();
    headers(req, res);
    res.status(200).send(result);
  } catch (error) {
    next(error);
  }
}

export const skillController = Object.freeze({
  listSkills,
  reloadSkills,
});
