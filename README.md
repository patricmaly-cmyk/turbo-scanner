# TurboScan Pro – Netlify Deployment

## Projektstruktur
```
turbo-netlify/
├── index.html                  ← Frontend (wird von Netlify geserved)
├── netlify.toml                ← Netlify Konfiguration
├── netlify/
│   └── functions/
│       └── quote.js            ← Serverless Function (Yahoo Finance Proxy)
└── README.md
```

## Deployment (5 Minuten)

### Schritt 1 – GitHub Repository erstellen
1. Gehe auf https://github.com → "New repository"
2. Name: `turbo-scanner` (oder beliebig)
3. **Public** auswählen
4. "Create repository" klicken

### Schritt 2 – Dateien hochladen
**Option A – per Browser (einfach):**
1. Im leeren Repository auf "uploading an existing file" klicken
2. Alle Dateien aus diesem ZIP **mit ihrer Ordnerstruktur** hochladen:
   - `index.html` → ins Root
   - `netlify.toml` → ins Root
   - `netlify/functions/quote.js` → in Unterordner `netlify/functions/`
3. "Commit changes" klicken

**Option B – per Git:**
```bash
git clone https://github.com/DEINNAME/turbo-scanner
# Dateien hineinkopieren
git add .
git commit -m "Initial commit"
git push
```

### Schritt 3 – Netlify verbinden
1. Gehe auf https://netlify.com → kostenlos registrieren
2. "Add new site" → "Import an existing project"
3. "GitHub" auswählen → Repository `turbo-scanner` auswählen
4. Build-Einstellungen (werden automatisch aus netlify.toml gelesen):
   - Build command: (leer lassen)
   - Publish directory: `.`
5. "Deploy site" klicken

### Schritt 4 – Fertig!
Nach ~30 Sekunden läuft das Tool auf:
`https://zufälliger-name.netlify.app`

Du kannst den Namen in Netlify Settings → Domain management ändern.

## Was passiert technisch?

```
Browser → /.netlify/functions/quote?symbols=NVDA,TSLA
       → Netlify Function (Node.js auf Netlify-Servern)
       → Yahoo Finance API (kein CORS-Problem da server-seitig)
       → Rückgabe als JSON ans Frontend
```

```
Browser → https://api.anthropic.com/v1/messages
       → Claude AI analysiert Turbo-Struktur pro Symbol
       → JSON mit Turbo-Parametern zurück
```

## Kosten
- Netlify Free Tier: 125.000 Function-Calls/Monat → völlig ausreichend
- Yahoo Finance: kostenlos (inoffiziell, kein Key nötig)
- Claude API: wird über deinen claude.ai Account abgerechnet

## Troubleshooting

**"Quote function returns error"**
→ Yahoo Finance ist manchmal temporär nicht verfügbar. Kurz warten und erneut scannen.

**"Keine Turbos gefunden"**
→ KO-Abstand erhöhen (z.B. auf 8%), Max-Preis auf 1.00€, Min-Hebel auf 10 setzen.

**"API Error"**
→ Prüfe ob du im claude.ai Interface eingeloggt bist.
