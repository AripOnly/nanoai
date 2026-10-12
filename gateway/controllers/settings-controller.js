// gateway/controllers/settings-controller.js

import settingsService from "../service/settings-service.js";

async function getSettings(req, res, next) {
  try {
    res.status(200).send(await settingsService.getSettings());
  } catch (error) {
    next(error);
  }
}

async function updateSettings(req, res, next) {
  try {
    res.status(200).send(await settingsService.updateSettings(req.body));
  } catch (error) {
    next(error);
  }
}

async function listProviders(req, res, next) {
  try {
    res.status(200).send(settingsService.listProviders());
  } catch (error) {
    next(error);
  }
}

export default { getSettings, updateSettings, listProviders };
