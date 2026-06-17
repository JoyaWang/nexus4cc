Check Nexus service status (launchd-managed).

```bash
launchctl print gui/$(id -u)/com.joya.nexus4cc | grep -E "state|pid|last exit"
```

Also confirm the process is actually listening (the real health check):
```bash
lsof -nP -iTCP:59000 -sTCP:LISTEN
```
