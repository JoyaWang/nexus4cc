Restart Nexus service (launchd-managed, NOT pm2).

```bash
launchctl kickstart -k gui/$(id -u)/com.joya.nexus4cc
```

Verify single instance on port 59000:
```bash
lsof -nP -iTCP:59000 -sTCP:LISTEN
```
