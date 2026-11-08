# FamilyHub

Planning a modular, self-hosted family server for 4–6 users, with a later public FOSS release.

The project integrates existing applications for movies, television, music, files and photos. Optional automatic downloads are included in the proposed architecture.

Read [the architecture review](ARCHITECTURE_REVIEW.md) for the service map, tradeoffs, storage and security boundaries, resource estimates, recovery design and decisions awaiting approval.

The independent [Astra](REVIEW_ASTRA.md) and [Opus](REVIEW_OPUS.md) reviews are complete. Read [their comparison](REVIEW_COMPARISON.md) for agreements, differing recommendations and the proposed simplifications.

Status: the first storage foundation is implemented and verified in the Debian development VM. Jellyfin and Navidrome pass sample playback checks inside the VM and through private localhost access on Windows; TV, phone and recovery checks remain pending. The project license is not yet selected.

See the [storage guide](docs/STORAGE.md) for the storage scripts and development VM helper.

Sample playback (Jellyfin and Navidrome with synthetic fixtures): see [the playback guide](docs/PLAYBACK.md).

Read the [verification record](docs/STORAGE_VERIFICATION.md) for completed checks and remaining limits. Shopping is deferred.

Read the [sample playback verification record](docs/PLAYBACK_VERIFICATION.md) for evidence and remaining checks.
