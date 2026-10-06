// src/gateway/controllers/config-controller.js

import { settings } from "../../src/config/setting.js";

export async function getSetting(req, res, next) {
  const key = req.body?.key;
  res.status(200).send(await settings.get(key));
}

export async function setSetting(req, res, next) {
  const key = req.body?.key;
  const value = req.body?.value;
  res.status(200).send(await settings.get(key, value));
}
