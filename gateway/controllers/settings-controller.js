// gateway/controllers/settings-controller.js

import settingsService from "../service/settings-service.js";

function setSettingsHeaders(res, meta) {
  if (meta.revision !== null && meta.revision !== undefined) {
    res.setHeader("X-Settings-Revision", String(meta.revision));
  }
  res.setHeader("X-Restart-Required", meta.restartRequired ? "true" : "false");
}

async function getSettings(req, res, next) {
  try {
    const data = await settingsService.getSettings();
    setSettingsHeaders(res, settingsService.getSettingsMeta());
    res.status(200).send(data);
  } catch (error) {
    next(error);
  }
}

async function updateSettings(req, res, next) {
  try {
    const result = await settingsService.updateSettingsWithMeta(req.body, {
      ifMatch: req.get("if-match"),
      origin: req.get("origin"),
    });
    setSettingsHeaders(res, result);
    res.status(200).send(result.data);
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
