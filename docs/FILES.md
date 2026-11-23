# Files: storage and sharing

FamilyHub's own take on a family cloud drive, in the spirit of Nextcloud: every profile has a private folder, the family has a shared folder, and any file can be sent to someone outside the family through a link that expires. It runs inside the existing server, with the existing family profiles, so there is no second login and no extra service.

## What exists (23 November 2026)

| Piece | Behaviour |
| --- | --- |
| Spaces | `family` (everyone) and `mine` (the signed-in profile only). On disk: `FILES_ROOT/family/` and `FILES_ROOT/profiles/<profile>/`. |
| Browse, folders | Listing sorted folders first, then names. Hidden dot-files and symbolic links never show. |
| Upload | A streamed `PUT` with a known length, written to a temporary file and moved into place only when complete. A taken name becomes `name (2).ext`. |
| Download | Forced download (`application/octet-stream`, `nosniff`), with range requests so a download can resume. |
| Rename and delete | Private files: their owner. Shared folder: the uploader or an administrator. A folder is deleted only when empty, or with `recursive=true`. |
| Share links | One file per link. Expiry of 1 hour, 1 day, 7 days or 30 days; optional password; optional download limit (1 makes it one-off). The list of a profile's links never includes the address. |
| Limits | Per upload `FILES_MAX_UPLOAD` (500 GB), per folder `FILES_QUOTA` (0, no limit; set bytes to cap the family folder and each profile) and `FILES_FREE_RESERVE` (20 GB) that the disk must keep free. The family server has a 10 TB data drive and a 4 TB backup drive, so the defaults leave space unrestricted; the development VM has about 14 GB free, so set the reserve lower and a quota there when testing. |

The app has a **Files** screen (apps menu): Family and My files tabs, breadcrumbs, folders, upload with a progress line, download (Windows saves to Downloads, phones open the share sheet), rename, delete with a confirmation, a share-link sheet (expiry, optional password, one-off) with copy and share buttons, and a list of your links with revoke. The screen is `wwwroot/files.js`; the .NET side (`FilesView.razor`) owns the network, the file picker and the clipboard. Unverified on a real phone or iPhone.

Set `FILES_ROOT` in the server configuration to switch the feature on. Without it every file endpoint answers that file sharing is not set up. `FILES_PUBLIC_URL` (for example `https://files.example.test`) makes created links absolute; without it they are relative to the server address.

## Share links: how they stay safe

- The secret in a link is 256 random bits. The server stores only its SHA-256 hash, so a copy of the database cannot reveal a working link.
- The page behind a link shows the file name and size and a download button. A chat app that previews the link therefore cannot use up a one-off link; only the download address counts.
- A password link asks for the password on that page. Wrong guesses are limited to 8 per 5 minutes per link.
- Expired, revoked, used-up and unknown links all answer the same "not available" page. Deleting a file withdraws its links.
- Files are always sent as downloads, never displayed, so an uploaded web page cannot run on the server's address.
- The activity log records counts and sizes, never file or folder names.
- A one-off link is counted when the download starts. If it fails, make a new link.

**Reachability.** A link only works for someone who can reach the server's address. The server is on a private Tailscale network today, so a colleague outside it cannot open a link. Reaching the outside needs a deliberate step, such as Tailscale Funnel or a reverse proxy, with `PUBLIC_ORIGIN` set to that address. Do this only for the share paths if possible.

## Toward the Nextcloud copy

Done: storage per profile, a family folder, quotas, links with expiry, password and limit, and the app screen.

Next, in this order, each a release of its own:

1. **Share with a specific profile.** Read or edit permission for one family member, shown in their Files screen.
2. **Trash and versions.** Deleted files wait 30 days; replaced files keep earlier versions.
3. **Previews.** Thumbnails for pictures, a viewer for PDFs, text and video (Jellyfin already plays video).
4. **Sync.** A phone folder that uploads photos automatically, then a desktop sync folder. WebDAV would give Windows and Mac drive mapping.
5. **Search by name and content.**
6. **Office-style editing.** Only if the family wants it; this is the heaviest piece and the main reason to run Nextcloud itself instead.

Backups: the files folder must be in the backup plan before real family data goes in. See [Storage](STORAGE.md).

## Server setup

1. Create the folder, owned by the service user: `install -d -o familyhub-writer -g familyhub-writer -m 2770 /srv/familyhub/data/files`.
2. The service runs with `ProtectSystem=strict`, so it can write only where `ReadWritePaths` says. Add a drop-in `/etc/systemd/system/familyhub-music-web.service.d/60-files.conf` containing `[Service]` and `ReadWritePaths=/srv/familyhub/data/files`, then `systemctl daemon-reload`. Without it the server stops at start with "Read-only file system".
3. Add `FILES_ROOT` (and any limits above) to `/etc/familyhub-music-web/config.json`, deploy the server code and restart.

The development VM runs with `FILES_ROOT=/srv/familyhub/data/files`, a 2 GB reserve, 2 GB uploads and a 3 GB quota, because only about 13 GB is free there.
