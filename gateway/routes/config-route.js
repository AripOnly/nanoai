// src/gateway/config-route.js

import { Router } from "express";
import { getSetting, setSetting } from "../controllers/config-controller.js";

const route = Router();

route.post("/get", getSetting);
route.post("/set", setSetting);

export default route;
