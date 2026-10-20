# Contract tests

Cross-module contracts live here: provider conformance, runtime dependencies,
session store semantics, and gateway/application boundaries. These tests use
fakes or local fixtures and never call a real provider API.

Run with `npm run test:contracts`.
