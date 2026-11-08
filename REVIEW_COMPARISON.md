# FamilyHub architecture review comparison

8 November 2026. Proposed revisions for owner review. No application implementation has started.

Both requested reviews are complete and preserved separately: [Astra medium](REVIEW_ASTRA.md) and [Opus medium](REVIEW_OPUS.md). Both read the unchanged v0.2 architecture plan at commit `ac95cf4`. They were instructed not to read one another's report. Paddock ran them sequentially because both used the current branch. Its task acceptance status confirms completion of the assigned report, not owner approval of the architecture.

The coordinator used pstack's read-only planning workflow and supplied the reviewers with the maintainability review skill's structural simplification and ownership criteria. These are architecture critiques, not code audits. Local Strata was offline, so no local model review ran. Both requested cloud workers used included accounts. No additional model review or fix loop ran.

## Judgment

The initial plan can be simpler to understand and operate. Most of its media acquisition components have distinct jobs; removing one can remove requested automation. The best first simplification is to evaluate **one family request portal covering movies, TV and music**, then avoid custom orchestration and automatic deletion until operation provides evidence that they are needed.

Keep the selected music, files, photos and collaboration capabilities while evaluating substitutions. A smaller container count does not establish an easier family experience. Actual counts also depend on version-specific databases and caches; compare maintained application groups and recovery procedures rather than treating the reviewers' rough counts as measurements.

## Agreements and differing recommendations

| Topic | Astra | Opus | Coordinator recommendation |
|---|---|---|---|
| Diagram | Separate family access, acquisition and recovery | Same | Done in v0.3; removed the duplicate import-service node |
| Music requests | Test Ombi as one portal for all media | Start with a shared request list; investigate a frontend | Test Ombi first; a shared list still leaves manual Lidarr entry |
| Music playback | Test Jellyfin music before adding Navidrome | Keep Navidrome/Substreamer | Keep selected stack as baseline; offer a Jellyfin/mobile-client trial if the owner prioritizes fewer services |
| Lists | Test Nextcloud Tasks before Mealie | Keep Mealie later | Keep Mealie for shopping/recipe/meal-planning needs; Tasks is an optional substitute only if those workflows and memberships pass |
| Files | Keep Nextcloud plus Samba because both are requested | Test phone SMB, then drop Nextcloud; otherwise use Nextcloud/WebDAV | Preserve both requirements. Phone SMB is an optional reduced-scope alternative, not proof that cloud features are replaced |
| Dashboard | Start with bookmarks | Static links served by Caddy | Homepage remains optional; bookmarks require no custom page and provide the simplest initial entry |
| Cleanup | Manual actions plus reconciliation initially | Same | Keep automatic cleanup report-only; one operator controls deletion |
| 16 GB RAM | Constrained and unmeasured | Remove services for margin | Stage modules, ML off, measure the representative workload; no guaranteed capacity |
| Backup | Independent target and blank-machine restore first | Same | Remains a gate before reliance on family originals |

## Checks on reviewer claims

**Ombi is a real candidate.** The coordinator checked upstream documentation and project information. It describes movie/music/TV requests, Radarr/Sonarr/Lidarr connections and Jellyfin integration. Family usability, current-version compatibility, album matching, music availability detection with Navidrome and failure recovery remain untested. This warrants an approved proof of concept, not immediate replacement. [Ombi project](https://github.com/Ombi-app/Ombi), [manager integration](https://docs.ombi.app/settings/all-the-arrs/), [Jellyfin integration](https://docs.ombi.app/settings/jellyfin/).

**The lean Immich configuration is documented.** Opus repeatedly describes the 4 GB ML-disabled arrangement as below a supported minimum. Upstream actually documents a general 6 GB minimum and explicitly permits 4 GB with ML disabled. The coordinator checked this distinction. Neither statement proves the entire FamilyHub stack fits 16 GB under concurrent load. [Immich requirements](https://docs.immich.app/install/requirements/).

**Direct SMB on phones changes the cloud proposition.** It may meet a narrow file retrieval test if the devices support the chosen client and VPN configuration. It does not establish Nextcloud's mobile sharing, selected-user links, cloud UI or other requested workflows. Replacing Samba with WebDAV also changes the explicit SMB requirement. Opus had no web access and marked these new external claims unverified; retain that qualification.

**A shared request list still needs administrator work.** It lets family members record requests themselves, but somebody must interpret each item, resolve its catalog match and add it to Lidarr. It does not remove the administrator bottleneck. Import-list integrations and any claim of a fully automatic playlist-to-album workflow also require upstream verification and failure tests.

**Consolidation trials must preserve the full use case.** Astra's proposal to replace Mealie with Tasks would also need to account for the brief's recipes and meal planning. Jellyfin music needs a suitable phone client with verified background playback and offline behavior. Neither review measured these journeys. Do not silently remove the existing selected applications.

**Keep the original priorities and development safety.** Opus suggests a files/music-first release and production-host validation. The brief makes movies/music the highest priority and requires development before the server arrives. Continue Windows-hosted Linux development and isolated restoration drills; perform QSV-specific validation on the Intel host before production reliance. Do not use real family data as the test environment.

## Proposed first implementation scope after approval

1. Base Linux VM, reproducible Compose configuration, secrets, stable naming/private access and a synthetic-data backup/restore drill.
2. Jellyfin and the selected music server/client, with existing-file playback, actual LG TV and phone tests.
3. One optional acquisition bundle: Radarr, Sonarr, Lidarr, qBittorrent and Prowlarr. Test Ombi before committing to a request portal. These services remain hidden from family administration.
4. Add files, photos and collaboration sequentially, retaining each requested feature until a replacement passes its specific acceptance tests and the owner approves it.
5. Keep ML, custom UI, generalized installer logic, SSO and destructive cleanup deferred. Add subtitle automation when sample Hungarian/English media shows the need; this remains a required capability to validate, not a removed requirement.

This is a proposed sequence, not permission to begin. Existing detailed security, storage and recovery boundaries remain in the architecture plan.

## Decisions for the owner

- Approve testing Ombi as the single self-service request portal, or explicitly prefer separate video and music request interfaces.
- Choose whether reducing services is important enough to trial Jellyfin music or Nextcloud Tasks against the selected specialist tools.
- Keep the full Nextcloud/SMB file use case, or explicitly accept a narrower direct-SMB phone experience after a device test.
- Name an independent backup destination available before critical data is moved.

The plan's other unresolved choices, including TLS/domain ownership, hosted VPN dependency, household membership, hardware fit and retention policy, remain recorded in its approval table.

## Verification and provenance

The coordinator inspected both completed reports and checked that each task changed only its assigned report. The original v0.2 plan was unchanged during both reviews. v0.3 changes the diagram presentation and music-request proposal; it does not approve component substitutions. Mermaid source was checked for consistent service names and balanced blocks, but was not rendered in a browser during this pass. No service, hardware, memory, mobile or restore acceptance test ran. Both reports remain recommendations, with original evidence limitations visible.
