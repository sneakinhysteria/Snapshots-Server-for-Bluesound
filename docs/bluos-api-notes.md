# BluOS API notes

Commands used by this app that are not covered by the public *BluOS Custom Integration API v1.7* (which states that fixed grouping is out of scope). They were observed in the BluOS controller app's traffic (BluOS 4.16) and verified against Pulse Soundbar+, Pulse Sub+ and Pulse Flex (1st gen). All requests go to `http://<player>:11000`.

## Fixed groups

| Action | Request (sent to) |
|---|---|
| Create stereo pair named *Stereo* | `GET /AddSlave?channelMode=right&group=Stereo&ports=11000&slaveChannelMode=left&slaves=<left-ip>` (right speaker = leader) |
| Create home cinema named *Living Room* | `GET /AddSlave?channelMode=front&distance=3.6&group=Living%20Room&ports=11000,11000&slaveChannelMode=side_right,side_left&slaveDistance=1.6,1.6&slaves=<ip1>,<ip2>` (soundbar = leader; distances in metres, only settable here) |
| Pair a subwoofer | `GET /AddSlave?pairSlave=1&slave=<sub-ip>&slaveChannelMode=subwoofer` (leader; takes the sub from a previous leader) |
| Dissolve fixed group | `GET /RemoveSlave?slaves=<ip1>,<ip2>&ports=11000,11000` (leader; also given as `zoneUngroup` in `/SyncStatus`) |
| Unpair subwoofer | `POST /RemoveSlave?slave=<sub-ip>&port=11000` with form body `unpair=1` (leader; as the BluOS app sends it, 2026-11-19 capture) |
| Member level / balance, sub trim | `GET /SlaveVolume?slave=<ip>&port=11000[&db=<-10..10>]` (leader) |

Group names must be URL-encoded with `%20` (not `+`). Group changes on a soundbar can take longer than 5 s to answer.

**Home cinema members** move to the soundbar's private subnet (`172.16.151.x`) and are not reachable from the LAN while grouped. The leader proxies requests: `GET /proxyToSlave?slave=<ip>:11000&url=/SyncStatus`.

**Stale entries**: after a sub is unpaired the soundbar may keep a `<zoneSlave … upgrading="true">` entry without `channelMode`; it is not a member.

**Leaving a home cinema group**: a stereo pair formed within ~15 s of leaving a home cinema group could look complete but never start playback (state stays `connecting`). Waiting ~30–45 s before grouping avoided it; a soft reboot (`POST http://<ip>/reboot` with `yes=1`) fixed it.

## Settings

Each player describes its settings in `GET /Settings?id=<page>` (redirects to port 11001). A group leader's tree also covers its members (`zone_player-<id>` pages) and paired sub (`subw`), with URLs pointing at the member (`http://<ip>:11000/...`) or `/proxyToSlave?slave=…&url=…`.

Writes: `POST <url>` with form body `<name>=<value>`, e.g.

| Setting | Request |
|---|---|
| Listening mode | `POST /audioPreset` `preset=movie` (the tree advertises `/alsa_setting`) |
| Soundbar tone (per listening mode) | `POST /alsa_setting` `eq-bass=0.5&preset=movie` |
| Tone controls, crossover | `POST /alsa_setting` `eq-switch=ON`, `eq-crossover=80` |
| Sub phase | `POST http://<sub>:11000/alsa_setting` `eq-phase_invert=1` |
| Indicator brightness | `POST <player>/setting` `ledbrightness=dim` |
| Volume limits, replay gain, sub on/off | `POST /audiomodes` `volumeLimits=-60,-14`, `replayGainMode=track`, `subwoofer=pairnetsub` |

Toggling Spatial Audio (`/i3d`) makes the player install a firmware upgrade.

## Streams and discovery

- `GET /Play?url=<encoded>` (documented) plays an endless FLAC stream over HTTP; WAV URLs are rejected.
- LSDP (UDP 11430, documented) is answered by the Pulse Soundbar+ but not by a 1st-gen Pulse Flex or the Pulse Sub+; neither did mDNS (`_musc._tcp`) in testing.
- `/Volume` and `/Status` support long-polling (`timeout`, `etag`). `/Volume` reports a `source` attribute.
