# Schneverdingen 3D

Interaktive 3D-Karte von Schneverdingen in der Lüneburger Heide. Sie läuft komplett im Browser, ohne Server, ohne API-Schlüssel und ohne Build-Schritt.

**Funktionen**

- **Auf Schneverdingen begrenzt:** Die Karte zeigt das Gemeindegebiet und etwa 2 km darum herum. Weiter lässt sie sich nicht verschieben oder herauszoomen. Alles außerhalb der Gemeindegrenze ist blass überdeckt. Die Grenzen dafür stehen in `js/main.js` (`minZoom`, `maxBounds`).
- **3D-Stadtmodell:** alle rund 24.700 Gebäude der Gemeinde aus dem amtlichen LoD2-Gebäudemodell des LGLN, mit echten Dachformen (Sattel-, Walm-, Krüppelwalmdach …). Die Dächer tragen das echte Luftbild (DOP20 des LGLN), man sieht also Ziegelfarbe, Solaranlagen und Flachdächer wie in Wirklichkeit. Die Fassaden richten sich nach der amtlichen Gebäudefunktion: Wohnhäuser in Klinker oder Putz mit Fenstern, Höfe mit Fachwerk, Ställe und Scheunen mit Holz oder Klinker, Hallen mit Blechverkleidung und Lichtband, Kirchen in Backstein
- **Gelände:** echtes Relief aus dem amtlichen Geländemodell DGM1 des LGLN, 4-fach überhöht, damit die flachen Heide-Hügel (29–157 m ü. NN) sichtbar werden. Dazu eine kräftige Reliefschattierung (Ebene „Relief“). Gebäude und Bäume stehen auf dem Gelände
- **Tageszeit:** Schieberegler mit dem echten Sonnenstand für Schneverdingen. Abends wird das Licht golden, nachts leuchten Fenster und Straßen. „Jetzt“ springt zur aktuellen Uhrzeit
- **Bäume:** Wälder, Parks, Gärten und Heideflächen werden mit Kiefern und Laubbäumen bepflanzt, berechnet aus den Kartendaten
- **Suche:** bekannte Orte (Rathaus, Heidegarten, Pietzmoor …) und jede Adresse in der Gemeinde
- **Gebäude-Info:** Klick auf ein Gebäude zeigt Adresse, Gebäudefunktion, Dachform und Höhe (aus den LGLN-Daten), die Entfernung zu Rathaus und Bahnhof sowie Haltestellen, Cafés, Geschäfte usw. im Umkreis von 300 m
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
| `data/lod2/` | Gebäude als Binärkacheln (1 × 1 km), erzeugt mit `tools/build_lod2.py` |
| `data/dem/`, `data/relief/` | Geländehöhen (Terrain-RGB) und Reliefschattierung, erzeugt mit `tools/build_dem.py` |
| `js/buildings.js` | Darstellung der Gebäude und Bäume (Three.js), Farben der Fassaden und Dächer im Shader |
| `js/layers.js` | Kartenebenen und ihre Farben |
| `css/style.css` | Farben und Schriften (oben im `:root`-Block) |

Eine gute Kameraposition für eine neue Tour-Station findest du so: Ansicht in der Karte einstellen und die Werte aus der Adresszeile übernehmen. Dort steht `#karte=zoom/breite/länge/drehung/neigung`. In `center` gehören Länge und Breite in umgekehrter Reihenfolge.

Die Tour-Texte sind kurz gehalten und sollten vor einer offiziellen Nutzung von jemandem mit Ortskenntnis gegengelesen werden.

## Gebäudedaten neu erzeugen

Die Gebäude stammen aus dem LoD2-Gebäudemodell des LGLN (CityGML, 1-km-Kacheln). So holst du eine neuere Fassung:

```bash
pip install lxml numpy pyproj mapbox_earcut
mkdir -p gml && cd gml
curl -O https://lod2.opengeodata.lgln.niedersachsen.de/LoD2_32_552_5885_1_ni.gml   # je Kachel, siehe unten
cd .. && python3 tools/build_lod2.py gml data/lod2
```

Die Kachelnamen lauten `LoD2_32_<Ostwert km>_<Nordwert km>_1_ni.gml` (UTM Zone 32). Für Schneverdingen sind es die Ostwerte 541–562 und die Nordwerte 5876–5897. Verwendet werden nur die Kacheln, die die Gemeinde berühren (194 Stück). Die CityGML-Dateien selbst (über 500 MB) liegen nicht im Repository.

### Gelände

Das LGLN bietet das DGM1 über einen WMS an, allerdings nur als 8-Bit-Graustufenbild. `tools/build_dem.py` lädt es in 10-m-Auflösung, rechnet die Grauwerte in Höhen um und glättet die Stufen. Die Umrechnungstabelle ist an den Bodenhöhen der LoD2-Gebäude kalibriert, die Abweichung liegt bei 0,6 m. Danach müssen die Gebäude mit dem Höhenraster neu umgewandelt werden:

```bash
pip install scipy pillow
python3 tools/build_dem.py arbeitsordner data/dem
python3 tools/fetch_dop.py gml luftbilder        # Luftbilder für die Dächer (194 × ~4 MB)
python3 tools/build_lod2.py gml data/lod2 arbeitsordner/dem.npz luftbilder
```

Für jede Kachel schneidet `build_lod2.py` die Dächer aus dem Luftbild aus und packt sie in einen Atlas (`data/lod2/<E>_<N>.jpg`, zusammen etwa 15 MB). Die Fassadenregeln stehen in `facade_class()` in `tools/build_lod2.py` und im Shader in `js/buildings.js`.

Die Überhöhung steht in `js/buildings.js` (`EXAG`). Mehr als 4,5-fach geht nicht, ohne das Datenformat zu ändern.

## Datenquellen und Lizenzen

| Daten | Quelle | Lizenz |
|---|---|---|
| Karte, Gebäude, Wege, Flächen | © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende über [OpenFreeMap](https://openfreemap.org) / [OpenMapTiles](https://openmaptiles.org) | ODbL |
| Gelände (DGM1) | © GeoBasis-DE/LGLN, [DGM1-WMS](https://opendata.lgln.niedersachsen.de/doorman/noauth/dgm_wms?SERVICE=WMS&REQUEST=GetCapabilities) | CC BY 4.0 |
| 3D-Gebäude (LoD2) | © GeoBasis-DE/LGLN, [OpenGeoData.NI](https://opengeodata.lgln.niedersachsen.de) | CC BY 4.0 |
| Luftbild (DOP20) | © GeoBasis-DE/LGLN, [OpenGeoData.NI](https://ni-lgln-opengeodata.hub.arcgis.com/) | CC BY 4.0 |
| Adresssuche | [Photon](https://photon.komoot.io) von komoot, OSM-Daten | ODbL |
| Umgebung und Wanderrouten (live) | [Overpass API](https://overpass-api.de), OSM-Daten | ODbL |
| Kartenbibliothek | [MapLibre GL JS](https://maplibre.org) 4.7.1 (`vendor/`) | BSD-3-Clause |
| 3D-Darstellung | [three.js](https://threejs.org) r160 (`vendor/`) | MIT |

Ist die Overpass API gerade nicht erreichbar, zeigt das Info-Panel eine vereinfachte Umgebung aus den Kartenkacheln. Bei den Wanderwegen erscheinen dann nur die Pfade und Feldwege.

Alle Dienste sind kostenlos und brauchen keinen Schlüssel. Für eine Seite mit sehr vielen Besuchern (z. B. als offizielles Angebot der Stadt) sollte man die Nutzungsbedingungen von Photon und Overpass prüfen und gegebenenfalls eigene Instanzen betreiben.
