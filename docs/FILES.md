# Files: storage and sharing

FamilyHub's own take on a family cloud drive, in the spirit of Nextcloud: every profile has a private folder, the family has a shared folder, and any file can be sent to someone outside the family through a link that expires. It runs inside the existing server, with the existing family profiles, so there is no second login and no extra service.

## What exists (server, 23 November 2026)

| Piece | Behaviour |
| --- | --- |
| Spaces | `family` (everyone) and `mine` (the signed-in profile only). On disk: `FILES_ROOT/family/` and `FILES_ROOT/profiles/<profile>/`. |
| Browse, folders | Listing sorted folders first, then names. Hidden dot-files and symbolic links never show. |
| Upload | A streamed `PUT` with a known length, written to a temporary file and moved into place only when complete. A taken name becomes `name (2).ext`. |
| Download | Forced download (`application/octet-stream`, `nosniff`), with range requests so a download can resume. |
| Rename and delete | Private files: their owner. Shared folder: the uploader or an administrator. A folder is deleted only when empty, or with `recursive=true`. |
| Share links | One file per link. Expiry of 1 hour, 1 day, 7 days or 30 days; optional password; optional download limit (1 makes it one-off). The list of a profile's links never includes the address. |
| Limits | Per upload `FILES_MAX_UPLOAD` (2 GB), per folder `FILES_QUOTA` (20 GB each for the family and every profile), and `FILES_FREE_RESERVE` (5 GB) that the disk must keep free. |

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

Done: storage per profile, a family folder, quotas, links with expiry, password and limit.

Next, in this order, each a release of its own:

1. **Files screen in the app.** Folder browser, upload, download, rename, delete, a link sheet, and a list of active links with revoke.
2. **Share with a specific profile.** Read or edit permission for one family member, shown in their Files screen.
3. **Trash and versions.** Deleted files wait 30 days; replaced files keep earlier versions.
4. **Previews.** Thumbnails for pictures, a viewer for PDFs, text and video (Jellyfin already plays video).
5. **Sync.** A phone folder that uploads photos automatically, then a desktop sync folder. WebDAV would give Windows and Mac drive mapping.
6. **Search by name and content.**
7. **Office-style editing.** Only if the family wants it; this is the heaviest piece and the main reason to run Nextcloud itself instead.

Backups: the files folder must be in the backup plan before real family data goes in. See [Storage](STORAGE.md).
