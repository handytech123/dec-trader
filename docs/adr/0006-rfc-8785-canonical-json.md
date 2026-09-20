# ADR 0006: RFC 8785 canonical JSON for content identity

- Status: Accepted
- Date: 2026-09-19
- Security impact: Reproducibility and authorization binding

## Context

Phase 1 must produce identical hashes across runs and eventually across services. The Phase 0
serializer specified sorted keys but did not fully define Unicode and JSON number behavior.

## Decision

Use the JSON Canonicalization Scheme defined by RFC 8785 through the Apache-2.0 `canonicalize`
package. Domain `bigint` values are represented as canonical base-10 strings before serialization;
undefined and non-finite numbers are rejected. Hash the UTF-8 canonical bytes with SHA-256 and the
`sha256:` prefix.

## Consequences

Published content hashes are stable and interoperable. Inputs must already use domain decimal
strings where exact decimal semantics matter. Changing canonicalization requires a new hash-schema
version and cannot rewrite published records.
