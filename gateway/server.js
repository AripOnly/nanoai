// gateway/server.js

import { app } from "./application/web.js";

const PORT = 3060;

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
