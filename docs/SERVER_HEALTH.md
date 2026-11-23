# Server health on Debian

The **Server** view and both `/api/server/` endpoints require an administrator. Configure a [profile password](SECURITY_REVIEW.md#profile-password-setup) for each FamilyHub administrator. Signed-in profiles can open **Leaderboard** through `/api/activity/stats`.

The collector starts with the service and reads every 15 seconds. It writes `.server-stats.sqlite3` and the SQLite WAL files under `WORKSPACE`. Keep that directory writable by the service account through `ReadWritePaths=` when using `ProtectSystem=strict`. SQLite keeps 15-second readings for 6 hours, one-minute readings for 7 days, and 15-minute readings for 90 days. History refreshes about once a minute. Charts combine older readings into at most 400 points per series.

## Optional config

Add these keys to the JSON loaded through `FAMILYHUB_MUSIC_CONFIG`.

| Key | Value |
| --- | --- |
| `SERVER_BACKUP_MOUNTS` | List of absolute mount points, such as `["/mnt/backup"]`. The dashboard also checks `/` and `/srv/familyhub`. An unmounted path shows **Mount unavailable**. |
| `SERVER_NETWORK_INTERFACES` | List of host interface names, such as `["enp3s0"]`. Omit it to discover hardware Ethernet interfaces. |
| `SERVER_VPN_PID` | Host PID of a process in the VPN container's network namespace. Set it together with `SERVER_VPN_INTERFACE` to read `/proc/<PID>/net/dev`. Update the PID and restart the collector service when the container is recreated. |
| `SERVER_VPN_INTERFACE` | Interface inside that namespace, such as `tun0` if that is the tunnel name. VPN traffic has its own chart and may also traverse the host Ethernet interface. |
| `SERVER_POWER_SOURCE` | Absolute path under `/sys` to a readable instantaneous whole-machine power measurement in microwatts, such as the `power1_input` of a Linux hwmon driver for a configured smart plug or UPS. Use the input that measures the FamilyHub machine alone. The source stays **Not measured** if the device exposes no compatible reading. |

Network totals sum recorded counter changes, and the range boundary can include part of the first retained bucket. Gaps and resets reduce coverage. CPU load is the Linux one-minute load average. The monthly energy estimate scales the measured mean over the last 24 hours to 30 days, even when fewer readings are available. The CPU package value covers the package only. It can take two samples for rates and package watts to appear and seven days for disk growth.

Free space counts blocks available to the service. Filesystem reserves can make the sum of used and free space smaller than the total.

CPU temperature uses `coretemp`, `k10temp`, or a CPU thermal zone. NVMe composite and `drivetemp` readings apply to the physical disks backing the monitored mounts. The dashboard's CPU warning levels are 70 °C and 85 °C. Disk warning levels are 45 °C and 55 °C. SMART status appears if a driver exposes it as a readable `smart_health` sysfs attribute on the disk or its device. Many disks expose SMART only through device commands. Those disks show **Not measured** for SMART.

## RAPL permissions

Keep `ProtectSystem=strict`, `ProtectKernelTunables=yes`, `PrivateDevices=yes`, and `NoNewPrivileges=yes`. Read-only sysfs is sufficient. Leave `/sys/class/powercap`, `/sys/class/hwmon`, `/sys/class/thermal`, `/sys/class/net`, `/sys/dev/block`, and their targets under `/sys/devices` visible in the unit's mount namespace. `ProcSubset=all` allows the system-wide proc readings. If using VPN counters, the service also needs permission to read the configured PID's `stat` and `net/dev`. A restricted `ProtectProc=` or a private PID namespace can hide them. The rest of the dashboard works with those restrictions in place.

Give the app's service group read access to the Intel package energy counter. Create a dedicated group.

```sh
getent group familyhub-rapl >/dev/null || groupadd --system familyhub-rapl
```

Add this drop-in under `/etc/systemd/system/familyhub-music-web.service.d/70-server-health.conf`.

```ini
[Service]
SupplementaryGroups=familyhub-rapl
```

Install this root-owned helper as `/usr/local/libexec/familyhub-rapl-permissions` with mode `0755`. Udev runs it for Intel RAPL devices and the helper grants access only to package counters.

```sh
#!/bin/sh
set -eu
zone="/sys$1"
case "$(cat "$zone/name" 2>/dev/null)" in
    package-*)
        chgrp familyhub-rapl "$zone/energy_uj"
        chmod 0440 "$zone/energy_uj"
        ;;
esac
```

Install `/etc/udev/rules.d/70-familyhub-rapl.rules` with this rule.

```udev
ACTION=="add", SUBSYSTEM=="powercap", KERNEL=="intel-rapl:[0-9]*", RUN+="/usr/local/libexec/familyhub-rapl-permissions %p"
```

```sh
udevadm control --reload-rules
udevadm trigger --action=add --subsystem-match=powercap
udevadm settle
systemctl daemon-reload
systemctl restart familyhub-music-web.service
```

Check `stat` on the package's `energy_uj` for group `familyhub-rapl` and mode `0440`. Verify package watts after two samples. The collector reads `max_energy_range_uj` to handle one wrap between samples and skips gaps longer than 30 seconds. Keep the app running as its unprivileged service user.

References. [Linux powercap](https://docs.kernel.org/power/powercap/powercap.html), [Linux hwmon](https://docs.kernel.org/hwmon/sysfs-interface.html), [systemd execution environment](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html), [udev rules](https://www.freedesktop.org/software/systemd/man/latest/udev.html).
