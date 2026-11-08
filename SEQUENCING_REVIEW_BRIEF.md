# FamilyHub implementation sequencing question

Requirements-only brief for independent reviews. 8 November 2026.

## Question

What implementation order should this project use, and what is the smallest useful first milestone that can be executed and objectively verified?

Compare the reasonable alternatives on their merits. No implementation order is preferred in this brief. Any sequence proposed in existing project notes is a hypothesis to assess, not a constraint. Reach a recommendation before consulting historical sequencing discussions or other reviewers' reports.

## Requirements and constraints

- Private family server for 4–6 people, later a publicly installable FOSS integration platform.
- Integrate mature applications and minimize distinct services, API connections and custom code while preserving functionality.
- Movie/TV playback, music playback, automatic movie/TV/music acquisition, file uploads/sharing and phone photo backup are desired capabilities.
- Shopping is deferred.
- Main family activities are Videos, Music, Files and Requests. Infrastructure administration stays separate from ordinary family use.
- Songs must be high quality. The owner has not specified an exact codec, bit depth, sample rate, allowed lossy fallback or mobile-streaming policy. Propose a precise practical policy and distinguish library originals from optional derived mobile streams. Do not assume a file extension establishes source authenticity.
- Movie/TV support should accommodate Hungarian/English audio and subtitles, 1080p and optional 4K, LG webOS, Android, iOS and desktop.
- Unique user accounts, private files, LAN operation without external internet, private remote access, persistent state, storage limits and independent backups are required.
- Automatic downloads use owner-authorized sources. Public examples contain no unauthorized sources or credentials. Use synthetic or appropriately licensed samples for tests.
- Initial production target is an i5-12500 with Intel integrated graphics, 16 GB RAM and one 1 TB SSD. No additional hardware purchase should be necessary for core services. Independent protection of critical data still needs a physically separate destination.
- Existing workstation is Windows 11 Pro, approximately 64 GB RAM and Ryzen CPU. Read-only preflight found virtualization enabled, a running hypervisor, Hyper-V management commands and about 1 TiB free on C:. No Linux VM, Docker daemon operation or GPU pass-through has been verified for this project.
- Develop on the workstation before the server arrives. Production-specific Intel hardware acceleration must eventually be checked on the production host.
- Candidate components include Jellyfin, Navidrome/mobile client, a request portal such as Ombi or Seerr, qBittorrent, Prowlarr, Radarr, Sonarr, Lidarr, Nextcloud, Samba and Immich. These are candidates, not a requirement to install them all in the first milestone.
- Work incrementally. Add a component only when its prerequisite checks pass; explicitly identify what an early test does and does not prove.

## Review output

1. Your recommended sequence, alternatives considered and the reasons for rejecting them.
2. A concrete first milestone with inputs, outputs, pass/fail checks and rollback boundaries.
3. Dependencies between file selection, acquisition, organization, metadata and playback.
4. A proposed high-quality music policy, including unavailable/incorrectly labeled releases.
5. Any unresolved owner decision that actually prevents the first milestone.
6. State whether you recommend starting that first milestone now or whether a specific blocker must be resolved first.

Keep recommendations independent. Do not read the other review. Label verified facts, proposals and untested assumptions. No deployment, installation, service configuration or runtime changes are part of the review assignment.
