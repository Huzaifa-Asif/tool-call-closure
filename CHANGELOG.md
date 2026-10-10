# Changelog

All notable changes will be documented here. This project follows Semantic Versioning.

## Unreleased

## 1.0.1 - 2026-10-10

### Added

- Ship and continuously execute the abort-safe provider-adapter example.
- Document the related durable execution-checkpoint boundary.

## 1.0.0 - 2026-10-06

### Fixed

- Recheck generation, closure, and settlement state after caller getters, JSON serialization, and string conversion. Preserve the first terminal result during reentrant operations.
- Reject reentrant generation replacement and sparse call arrays before an outer registration can supersede a newer or valid existing batch.
- Keep fixed built-in error codes usable with small `maxCodeBytes` limits; the limit applies to explicitly supplied codes.
- Reject untrusted snapshot objects before reading their properties.

### Added

- Add bounded tool-call generations, exactly-once settlement, synthetic closure provenance, stale-result fencing, and explicit OpenAI Chat Completions, OpenAI Responses, and Anthropic adapters.
