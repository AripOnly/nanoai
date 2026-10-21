// gateway/controllers/job-controller.js
//
// Thin HTTP door for the job service. Session scoping is required on every
// operation; the service owns validation and error translation.

import { createJobService } from "../service/job-service.js";

function service(req) {
  return createJobService(req.app.locals.jobs);
}

async function listJobs(req, res, next) {
  try {
    const jobs = await service(req).list(req.query ?? {});
    res.status(200).send({ jobs });
  } catch (error) {
    next(error);
  }
}

async function getJob(req, res, next) {
  try {
    const job = await service(req).get(req.params.job_id, req.query ?? {});
    res.status(200).send(job);
  } catch (error) {
    next(error);
  }
}

async function killJob(req, res, next) {
  try {
    const job = await service(req).kill(
      req.params.job_id,
      req.body ?? {},
      req.query ?? {},
    );
    res.status(200).send(job);
  } catch (error) {
    next(error);
  }
}

async function removeLog(req, res, next) {
  try {
    const result = await service(req).removeLog(
      req.params.job_id,
      req.query ?? {},
    );
    res.status(200).send(result);
  } catch (error) {
    next(error);
  }
}

export const jobController = Object.freeze({
  listJobs,
  getJob,
  killJob,
  removeLog,
});
