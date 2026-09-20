# Isolated signer trust boundary

No signer is implemented in Phase 0. A future signer must run in a separate runtime, filesystem, and
environment; accept only exact, expiring authorizations; independently parse every instruction; and
expose no generic message signing, arbitrary transfer, seed export, or raw-transaction API.
