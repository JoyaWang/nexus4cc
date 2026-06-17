Stop Nexus service (launchd-managed).

NOTE: `com.joya.nexus4cc` has KeepAlive=true, so a plain kill will respawn it.
To truly stop, unload the agent:

```bash
launchctl bootout gui/$(id -u)/com.joya.nexus4cc
```

To start it again later:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.joya.nexus4cc.plist
```
