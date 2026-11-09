# Schneverdingen 3D

Interaktive 3D-Karte von Schneverdingen in der Lüneburger Heide. Sie läuft komplett im Browser, ohne Server, ohne API-Schlüssel und ohne Build-Schritt.

**Funktionen**

- **3D-Stadtmodell:** Gebäude mit Höhen aus OpenStreetMap, frei dreh- und neigbar
- **Suche:** bekannte Orte (Rathaus, Heidegarten, Pietzmoor …) und jede Adresse in der Gemeinde
- **Gebäude-Info:** Klick auf ein Gebäude zeigt Adresse, Höhe, Entfernung zu Rathaus und Bahnhof sowie Haltestellen, Cafés, Geschäfte usw. im Umkreis von 300 m
- **Kartenebenen:** Luftbild (LGLN), 3D-Gebäude, Heideflächen, Wald, Gewässer & Moore, Naturschutzgebiete, Straßen nach Typ, Bahn & Bus, Wanderwege, Gemeindegrenze
- **Heide-Tour:** Rundflug über 9 Stationen von der Stadtmitte über Höpen, Osterheide und Pietzmoor zum Bahnhof

Die Position steht in der Adresszeile (`#karte=zoom/lat/lon/drehung/neigung`). So lässt sich jede Ansicht als Link teilen.

## Lokal starten

```bash
python3 -m http.server 8000
```

Dann <http://localhost:8000> öffnen. Ein Doppelklick auf `index.html` reicht nicht, weil der Browser dann die Daten-Dateien blockiert.

## Auf GitHub Pages veröffentlichen

1. Repository auf GitHub pushen (Branch `main`).
2. Auf GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Der Workflow `.github/workflows/pages.yml` veröffentlicht die Seite bei jedem Push auf `main`. Die Adresse lautet dann `https://<benutzer>.github.io/<repo>/`.

## Inhalte anpassen

| Datei | Inhalt |
|---|---|
| `data/tour.json` | Stationen der Heide-Tour: Titel, Text, Kameraposition (`center` = [Länge, Breite], `zoom`, `pitch` = Neigung, `bearing` = Drehung) |
| `data/places.json` | Orte, die die Suche zuerst vorschlägt, mit Suchbegriffen (`aliases`) |
| `data/gemeindegrenze.geojson` | Gemeindegrenze (aus OpenStreetMap) |
| `js/layers.js` | Kartenebenen und ihre Farben |
| `css/style.css` | Farben und Schriften (oben im `:root`-Block) |

Eine gute Kameraposition für eine neue Tour-Station findest du so: Ansicht in der Karte einstellen und die Werte aus der Adresszeile übernehmen. Dort steht `#karte=zoom/breite/länge/drehung/neigung`. In `center` gehören Länge und Breite in umgekehrter Reihenfolge.

Die Tour-Texte sind kurz gehalten und sollten vor einer offiziellen Nutzung von jemandem mit Ortskenntnis gegengelesen werden.

## Datenquellen und Lizenzen

| Daten | Quelle | Lizenz |
|---|---|---|
| Karte, Gebäude, Wege, Flächen | © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende über [OpenFreeMap](https://openfreemap.org) / [OpenMapTiles](https://openmaptiles.org) | ODbL |
| Luftbild (DOP20) | © GeoBasis-DE/LGLN, [OpenGeoData.NI](https://ni-lgln-opengeodata.hub.arcgis.com/) | CC BY 4.0 |
| Adresssuche | [Photon](https://photon.komoot.io) von komoot, OSM-Daten | ODbL |
| Umgebung und Wanderrouten (live) | [Overpass API](https://overpass-api.de), OSM-Daten | ODbL |
| Kartenbibliothek | [MapLibre GL JS](https://maplibre.org) 4.7.1 (`vendor/`) | BSD-3-Clause |

Ist die Overpass API gerade nicht erreichbar, zeigt das Info-Panel eine vereinfachte Umgebung aus den Kartenkacheln. Bei den Wanderwegen erscheinen dann nur die Pfade und Feldwege.

Alle Dienste sind kostenlos und brauchen keinen Schlüssel. Für eine Seite mit sehr vielen Besuchern (z. B. als offizielles Angebot der Stadt) sollte man die Nutzungsbedingungen von Photon und Overpass prüfen und gegebenenfalls eigene Instanzen betreiben.
