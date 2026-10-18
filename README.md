# Snapshots Server for Bluesound

Store and recall BluOS speaker setups with one button. BluOS lets a speaker belong to only one fixed group, so switching between, for example, a home cinema (soundbar + surrounds + sub) and a stereo pair (two speakers + sub) normally means rebuilding groups in the BluOS app. This app snapshots each setup once and recreates it on demand.

- **Snapshots**: fixed groups (stereo pairs, home cinema with channel roles and speaker distances), subwoofer pairing, member and sub levels, audio and subwoofer settings (listening mode, tone controls, crossover, phase, …), volume and mute.
- **Recall**: dissolves what differs, rebuilds the setup, restores levels and settings, checks silently that the group actually plays, and verifies the result.
- **AirPlay 2 receiver** per setup for speakers without AirPlay 2 (e.g. 1st-gen Pulse Flex), active only while that setup is in place.
- **CEC volume protection**: learns volume changes a TV sends by itself over HDMI-CEC (e.g. periodic drift) and undoes them, without blocking the remote control.
- **Volume when the TV starts**: fixed volume or a maximum when a player switches to the TV input.
- **Activity log** of volume, input and format changes on all players (live).
- Local only: uses the BluOS HTTP API (port 11000) on your network, no cloud account.

Setups are built in the BluOS app; this app only stores and recreates them.

<p>
  <img src="docs/screenshots/snapshots.png" alt="Snapshots tab: stored setups with recall buttons, the active one highlighted, and the current setup" width="49%">
  <img src="docs/screenshots/speakers.png" alt="Speakers tab: discovered speakers with model, firmware, role in the current setup and how they were found" width="49%">
</p>

## Requirements

- Docker on a host in the same network as the speakers (Linux; host networking is required).
- Free TCP port 8095 (configurable), UDP 11430 (speaker discovery), and for AirPlay TCP 7000+ and UDP 319/320.
- Tested with Pulse Soundbar+, Pulse Sub+ and Pulse Flex (1st gen) on BluOS 4.16.

## Install with Docker Compose

```sh
mkdir snapshots-server-for-bluesound && cd snapshots-server-for-bluesound
curl -O https://raw.githubusercontent.com/sneakinhysteria/Snapshots-Server-for-Bluesound/main/deploy/docker-compose.yml
docker compose up -d
```

Open `http://<host>:8095`.

## Unraid

**Option A — Docker template (no plugins)**

1. Copy [`unraid/snapshots-server-for-bluesound.xml`](unraid/snapshots-server-for-bluesound.xml) to `/boot/config/plugins/dockerMan/templates-user/my-snapshots-server-for-bluesound.xml` on the flash drive (e.g. via the Unraid terminal: `wget -O /boot/config/plugins/dockerMan/templates-user/my-snapshots-server-for-bluesound.xml https://raw.githubusercontent.com/sneakinhysteria/Snapshots-Server-for-Bluesound/main/unraid/snapshots-server-for-bluesound.xml`).
2. **Docker** tab → **Add Container** → **Template**: select *snapshots-server-for-bluesound* under *User templates*.
3. Check the values (Network Type **Host**, AppData path, port) and click **Apply**.
4. Open the WebUI from the container's icon menu.

**Option B — manual Add Container**

Docker tab → Add Container, then set:

| Field | Value |
|---|---|
| Name | `snapshots-server-for-bluesound` |
| Repository | `ghcr.io/sneakinhysteria/snapshots-server-for-bluesound:latest` |
| Network Type | `Host` |
| WebUI | `http://[IP]:[PORT:8095]/` |
| Path `/data` | `/mnt/user/appdata/snapshots-server-for-bluesound` |
| Path `/var/run/dbus` | `/var/run/dbus` (host's D-Bus, for AirPlay announcements) |
| Variable `PORT` | `8095` |
| Variable `TZ` | your time zone, e.g. `Europe/Berlin` |

**Option C — Compose Manager plugin**

1. Docker tab → *Compose* section → **Add New Stack**, name it `snapshots-server-for-bluesound`.
2. *Edit Stack* → *Compose File*: paste [`unraid/compose-manager/docker-compose.yml`](unraid/compose-manager/docker-compose.yml) (adjust `TZ`).
3. *Edit Stack* → *UI Labels*: icon `https://raw.githubusercontent.com/sneakinhysteria/Snapshots-Server-for-Bluesound/main/public/icon.png`, WebUI `http://<server-ip>:8095` — or paste [`unraid/compose-manager/docker-compose.override.yml`](unraid/compose-manager/docker-compose.override.yml) as override with your server IP.
4. **Compose Up**. Updates: *Update Stack*.

Tip: give the speakers fixed addresses (DHCP reservations) in your router. The app identifies speakers by MAC address and finds them again anyway, but other integrations (e.g. Home Assistant) may be configured by IP.

## Configuration

All settings are optional; defaults are detected automatically.

| Variable | Default | |
|---|---|---|
| `PORT` | `8095` | Web UI / API port |
| `TZ` | UTC | Time zone for the activity log |
| `BLUOS_SUBNETS` | auto | Comma-separated subnets to scan for players (/22 or smaller), e.g. `192.168.1.0/24` |
| `BLUOS_SCAN` | on | `off` disables the subnet scan (LSDP and known addresses only) |
| `PUBLIC_URL` | auto | Base URL the speakers use to fetch streams from this app, e.g. `http://192.168.1.10:8095` |
| `AVAHI_INTERFACES` | default-route interface | Own Avahi only: interfaces AirPlay receivers are announced on, e.g. `br0` |
| `AVAHI_HOSTNAME` | `snapshots-server-for-bluesound` | Own Avahi only: mDNS host name of the container |
| `MDNS` | on | `off` stops announcing the server via mDNS (`_bluossnapshots._tcp`) |
| `MDNS_NAME` | `Snapshots Server for Bluesound on <host>` | Name the server is announced under |
| `DATA_DIR` | `/data` | Database location |

**AirPlay announcements**: mount the host's D-Bus (`/var/run/dbus:/var/run/dbus`, included in the compose file and Unraid template) so the receivers are announced by the host's Avahi. With host networking, a second Avahi inside the container fights the host's one over the address records; both rename themselves ("Server-2", "-3", …) until the host's stops answering. If that happened, restart the host's Avahi (Unraid: `/etc/rc.d/rc.avahidaemon restart`). Without the mount (hosts without Avahi) the container runs its own.

**Server announcement**: the server announces itself as `_bluossnapshots._tcp` on its port, with TXT records `version=<commit>` and `path=/api`, so apps on the network find it without an address.

**Discovery**: players are found via LSDP (the Bluesound broadcast protocol, UDP 11430), previously known addresses, group members reported by their leader, and a scan of the host's local subnets. Some devices (1st-gen Pulse Flex, Pulse Sub+) don't announce themselves via LSDP or mDNS and are only found by the scan. Docker, VM and VPN interfaces are ignored.

## Usage

1. Build a setup in the BluOS app (e.g. stereo pair + sub).
2. In the web app, enter a name under *Current setup* and **Save**.
3. Repeat for other setups (e.g. home cinema).
4. **Recall** switches to a stored setup. The active setup is highlighted.
5. **Edit** changes stored values (settings, levels, volume, home cinema distances, AirPlay name). A changed distance rebuilds the group on recall, because distances can only be set when a group is created.

### AirPlay

Enter an *AirPlay name* in a setup's edit form. While that setup is active, an AirPlay 2 receiver with this name is offered (shairport-sync); the audio is streamed to the group as FLAC. Volume from the iPhone/iPad is applied to the BluOS player. Expect ~5–6 s delay (fine for music, not for video). AirPlay itself is limited to CD-quality audio.

BluOS only sees an untitled stream, so the app exposes what the AirPlay sender provides (title, artist, album, cover, progress) for other displays, with CORS enabled:

| Method | Path | |
|---|---|---|
| GET | `/api/airplay` | Receivers incl. `stream` path and `nowPlaying` |
| GET | `/api/airplay/<id>/nowplaying` | `title`, `artist`, `album`, `durationS`, `positionS` (at `positionAt`), `cover` (path), `coverUrl` (full URL), `playing` |
| GET | `/api/airplay/<id>/cover` | Cover image |
| GET | `/api/airplay/stream` | Live updates of all receivers (Server-Sent Events) |

A display can tell that a BluOS player is playing a receiver when the player's stream URL ends with the receiver's `stream` path.

### CEC volume protection (Helpers tab)

Some TVs change the soundbar volume over HDMI-CEC by themselves: at power-on, for "volume sync", or because of firmware bugs. Example: a Philips 58PUS8506 sent a CEC volume step every ~15 min 01 s, single or as a burst of three (first two ~0.13 s apart); for months upwards, later downwards. The Activity log shows such changes with `source: CEC`.

The app groups CEC volume changes into sequences and learns repeating patterns per player from the last 24 h: a regular interval (1 min – 2 h) with at least three matches, plus whether the pattern contains bursts faster than remote clicks. The Helpers tab shows the result in plain words ("every 15 min 01 s, down, 1–3 steps, 6× since 10:34") or that no pattern was found.

| Mode | |
|---|---|
| Off | Nothing |
| Detect only | Logs detections in Activity (default) |
| Undo automatic changes | Restores the previous volume when a change fits the learned pattern (±15 s of the expected time, or a burst if the pattern has bursts). Remote clicks are left alone. Both directions. |
| Lock volume | Undoes every CEC volume change; change the volume via the BluOS app or Home Assistant |

`GET /api/guard`, `PUT /api/guard {"mode": "undo"}`.

### Volume when the TV starts (Helpers tab)

When a player switches to a TV input (by default inputs named TV, HDMI or ARC; selectable), the app sets a **fixed volume** or **limits it to a maximum** a few seconds later. With the limit, CEC volume increases above it are also corrected for 90 s, since TVs and streaming boxes often send a volume shortly after power-on. `GET/PUT /api/tvstart` (`{"mode": "max", "level": 40, "inputs": ["TV"]}`).

## Automation (Home Assistant, Node-RED, Shortcuts)

Snapshots can be recalled by name, and the current state is available as JSON. There is no authentication; keep the app on your local network.

| Method | Path | |
|---|---|---|
| POST | `/api/recall/<name>` | Recall a snapshot by name (case-insensitive, URL-encoded). Returns `202` with the job; `404` lists the available names; `409` while another recall runs. |
| GET | `/api/state` | `active` (name of the snapshot matching the current setup or `null`), `names`, `recall` (last recall: `status` running/done/failed, `differences`), `airplay` |

```sh
curl -X POST http://192.168.1.10:8095/api/recall/Home%20Cinema
curl http://192.168.1.10:8095/api/state
```

### Home Assistant

Add to `configuration.yaml` (replace the address), then restart Home Assistant:

```yaml
rest_command:
  bluesound_recall:
    url: "http://192.168.1.10:8095/api/recall/{{ name | urlencode }}"
    method: post

rest:
  - resource: http://192.168.1.10:8095/api/state
    scan_interval: 30
    sensor:
      - name: Bluesound setup
        unique_id: bluesound_snapshots_setup
        value_template: "{{ value_json.active or 'none' }}"
        json_attributes: [names, recall, airplay]
      - name: Bluesound recall
        unique_id: bluesound_snapshots_recall
        value_template: "{{ value_json.recall.status if value_json.recall else 'idle' }}"

template:
  - select:
      - name: Bluesound snapshot
        unique_id: bluesound_snapshots_select
        state: "{{ states('sensor.bluesound_setup') }}"
        options: "{{ state_attr('sensor.bluesound_setup', 'names') or [] }}"
        select_option:
          - action: rest_command.bluesound_recall
            data:
              name: "{{ option }}"
```

This gives you:

- **`select.bluesound_snapshot`**: dropdown of all snapshots showing the active one; choosing an entry recalls it. New snapshots appear after the next sensor update.
- **`sensor.bluesound_setup`**: active snapshot (`none` if the speakers match no snapshot).
- **`sensor.bluesound_recall`**: `idle`, `running`, `done` or `failed`.
- **`rest_command.bluesound_recall`** for automations and buttons, e.g. switch to the home cinema when the TV turns on:

```yaml
automation:
  - alias: Home cinema when the TV turns on
    triggers:
      - trigger: state
        entity_id: media_player.tv
        to: "on"
    conditions:
      - condition: not
        conditions:
          - condition: state
            entity_id: sensor.bluesound_setup
            state: Home Cinema
    actions:
      - action: rest_command.bluesound_recall
        data:
          name: Home Cinema
```

A recall takes 30 s to 2 min; the speakers are silent meanwhile.

### Node-RED, iOS Shortcuts, scripts

Send `POST /api/recall/<name>` with any HTTP client (Node-RED *http request* node, Shortcuts *Get Contents of URL* with method POST). Poll `GET /api/state` until `recall.status` is no longer `running` if you need to wait for the result.

## How recall works

1. Read the current setup; groups that already match the snapshot are kept.
2. Dissolve other groups via their leader (members first, then the sub).
3. Wait until the speakers are back on the network (home cinema members live on the soundbar's private subnet while grouped); after leaving a home cinema group wait another 30 s.
4. Rebuild with channel roles, group name and distances, then pair the sub.
5. Play digital silence at volume 0 and check that playback starts. If not, restart the group's speakers once and rebuild.
6. Restore levels, settings (only values that differ) and volume, then read the setup again and report differences.

Command formats for fixed groups and settings are not part of the public BluOS API documentation; they were taken from the BluOS app's network traffic (`docs/capture/`).

## API

| Method | Path | |
|---|---|---|
| GET | `/api/current[?cached=1]` | Current setup (+ ids of matching snapshots); `cached=1` returns the last stored read |
| GET | `/api/snapshots` | List snapshots |
| POST | `/api/snapshots` `{name}` | Save current setup |
| POST | `/api/snapshots/import` `{name, data}` | Store a snapshot from its data (same format as `data` in the list); 201, or 409 if the name exists |
| PATCH | `/api/snapshots/:id` `{name}` | Rename |
| PUT | `/api/snapshots/:id/values` `{zones}` | Edit stored values |
| POST | `/api/snapshots/:id/capture` | Replace with current setup |
| DELETE | `/api/snapshots/:id` | Delete |
| POST | `/api/snapshots/:id/recall` | Start recall, returns job |
| GET | `/api/jobs/:id`, `/api/jobs/running` | Recall progress |
| GET | `/api/events?kind=volume` | Activity log |
| GET | `/api/events/stream` | Activity log, live (Server-Sent Events) |
| GET/PUT | `/api/guard` | CEC volume protection: status and learned patterns / `{"mode": "off\|detect\|undo\|lock"}` |
| GET/PUT | `/api/tvstart` | Volume when the TV starts / `{"mode": "off\|fixed\|max", "level", "inputs"}` |
| GET | `/api/airplay` | AirPlay receivers |
| GET | `/api/speakers[?scan=1]` | Speaker list (`scan=1` runs a full discovery) |
| POST | `/api/speakers/:mac/restart` | Restart a speaker (202; 409 while a recall runs, when it doesn't respond, or when it is only reachable through a soundbar) |
| POST | `/api/recall/<name>` | Recall by name (see *Automation*) |
| GET | `/api/state` | Active snapshot, names, last recall (see *Automation*) |

## Development

```sh
npm install
npm run dev        # Node ≥ 22.18, runs TypeScript directly
npm run typecheck
docker build -t snapshots-server-for-bluesound .
```
