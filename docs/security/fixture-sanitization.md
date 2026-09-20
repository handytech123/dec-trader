# Provider fixture policy

Phase 0 fixtures are synthetic. A later recorded fixture must document provider, capture time,
schema version, source version, sanitization method, and a stable hash of the sanitized payload.

Remove credentials, headers, account identifiers not essential to the test, signed transactions,
signatures that identify the experiment wallet, URLs containing tokens, cookies, and personal data.
Replace values consistently when referential integrity matters. Validate the sanitized fixture
against the adapter schema and secret scanner before commit. Never overwrite a published fixture;
add a versioned replacement.
