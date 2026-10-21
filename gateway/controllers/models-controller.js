// gateway/controllers/models-controller.js
//
// Read-only model catalog view. The response is one flat list keyed by
// provider; credentials/endpoints never appear here.

import settingsService from "../service/settings-service.js";

async function listModels(req, res, next) {
  try {
    const meta = settingsService.getModelsMeta();
    if (meta.revision !== null && meta.revision !== undefined) {
      res.setHeader("X-Models-Revision", String(meta.revision));
    }
    if (meta.lastError) {
      res.setHeader("X-Models-Error", "true");
    }
    res.status(200).send({
      revision: meta.revision,
      lastError: meta.lastError,
      models: settingsService.listModels(),
    });
  } catch (error) {
    next(error);
  }
}

export default { listModels };
