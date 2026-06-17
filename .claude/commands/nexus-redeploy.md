Rebuild frontend and restart Nexus service.

Nexus is managed by launchd (label: `com.joya.nexus4cc`), NOT pm2.
Do NOT use pm2 — it caused a dual-supervisor port conflict (see git history).

```bash
cd /Users/joya/JoyaProjects/nexus4cc/frontend && npm run build && launchctl kickstart -k gui/$(id -u)/com.joya.nexus4cc
```

Verify the single instance came back up on port 59000:
```bash
lsof -nP -iTCP:59000 -sTCP:LISTEN && tail -3 ~/.nexus4cc.out.log
```
