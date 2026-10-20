# Integration tests

End-to-end tests live here: gateway HTTP/SSE, abort, migrations, settings
hot-reload, background jobs, and skills-install fixtures. They run against a
temporary `NANO_DATA_DIR` and must not require live credentials.

Run with `npm run test:integration`.
