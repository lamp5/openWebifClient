# TV z dekodera Enigma2 w przeglądarce

Aplikacja w HTML + JS do oglądania kanałów z dekodera Enigma2 (OpenWebif) na PC, z listą kanałów z pliku `playlist.m3u8`, EPG, ulubionymi i nagrywaniem.

## Pliki

| Plik | Do czego |
|---|---|
| `index.html` | Aplikacja (lista kanałów, odtwarzacz, EPG). Struktura i skrypt, bez budowania. |
| `style.css` | Style aplikacji (układ, kolory). |
| `server.js` | Lokalny serwer Node.js: wydaje `index.html` i playlistę oraz pośredniczy w pobieraniu strumieni i EPG z dekodera (omija CORS), wycina z multipleksu wybrany program i opcjonalnie przekodowuje przez ffmpeg. |
| `start.bat` / `start.sh` | Uruchamianie jednym kliknięciem: Windows (`start.bat`) oraz macOS/Linux (`start.sh`). |
| `config.json` | Konfiguracja: adres dekodera, porty, źródło kanałów, tryb ffmpeg (opis niżej). |
| `playlist.m3u8` | Playlista z dekodera. **Opcjonalna**: używana tylko jako zapas albo gdy `source` to `playlist`. |

Pliki muszą leżeć w jednym folderze.

## Wymagania

- **Node.js** (dowolna nowsza wersja, bez żadnych paczek npm).
- **ffmpeg** w PATH, potrzebny do dźwięku na większości kanałów i do przekodowania obrazu (patrz niżej).
- Przeglądarka oparta na Chromium lub Firefox. Do załadowania biblioteki mpegts.js potrzebny jest internet (CDN jsDelivr).
- Dekoder w tej samej sieci, z włączonym OpenWebif (port 80) i streamingiem (port 8001).

### Instalacja ffmpeg

- Windows: `winget install Gyan.FFmpeg`
- macOS: `brew install ffmpeg`
- Linux: `sudo apt install ffmpeg`

Po instalacji otwórz **nowy** terminal i sprawdź `ffmpeg -version`.

## Uruchomienie

```
node server.js --transcode
```

Przeglądarka otworzy się sama (`openBrowser` w `config.json`, flaga `--no-open` to wyłącza). Jeśli aplikacja już działa, ponowne uruchomienie tylko otworzy ją w przeglądarce.

### Uruchamianie jednym kliknięciem

- **Windows:** dwuklik na `start.bat`. Okno z logami musi zostać otwarte, bo jego zamknięcie zatrzymuje serwer. Skrót na pulpit: prawy przycisk na `start.bat` → Wyślij do → Pulpit (utwórz skrót).
- **macOS / Linux:** `./start.sh` (jeśli trzeba, najpierw `chmod +x start.sh`).

Oba skrypty przekazują argumenty dalej, np. `start.bat --no-transcode`. Zatrzymanie serwera: `Ctrl+C` albo zamknięcie okna.

Przy `"transcode": true` w `config.json` wystarczy samo `node server.js`.

Pierwsze linie w terminalu pokazują źródło kanałów i tryb pracy, np. `(ffmpeg: audio -> AAC, wideo -> przekodowane)`.

### Tryby

| Polecenie | Co robi | Kiedy |
|---|---|---|
| `node server.js --transcode` | ffmpeg przekodowuje obraz (deinterlace, czysty H.264) i dźwięk (AAC). | **Zalecany.** Działa na kanałach, na których przeglądarka inaczej się zawiesza. Używa CPU. |
| `node server.js` (z ffmpeg) | Obraz kopiowany bez zmian, dźwięk przekodowany na AAC. | Gdy kanał gra bez przekodowania, a chcesz oszczędzić CPU. |
| `NO_FFMPEG=1 node server.js` | Bez ffmpeg: filtr zostawia tylko obraz i dźwięk AAC. | Awaryjnie. Większość kanałów będzie bez dźwięku. |

Zmienne środowiskowe: `PORT` (domyślnie 8080), `FFMPEG` (ścieżka do ffmpeg), `NO_FFMPEG`, `TRANSCODE`.

- Windows (cmd): `set PORT=9000 && node server.js --transcode`
- PowerShell: `$env:PORT=9000; node server.js --transcode`
- Linux/macOS: `PORT=9000 node server.js --transcode`

## Konfiguracja (`config.json`)

Plik jest opcjonalny (bez niego obowiązują wartości domyślne), ale musi być poprawnym JSON-em. Błąd składni kończy start serwera z komunikatem. Po każdej zmianie zrestartuj serwer.

| Klucz | Domyślnie | Znaczenie |
|---|---|---|
| `decoder` | `null` | Adres IP dekodera, np. `"192.168.0.233"`. Bez niego kanały idą z pliku playlisty. |
| `webPort` | `80` | Port OpenWebif (lista kanałów, EPG, timery, picony). |
| `streamPort` | `8001` | Port strumieni. |
| `port` | `8080` | Port tej aplikacji (`http://localhost:PORT`). |
| `openBrowser` | `true` | Czy po starcie otworzyć przeglądarkę. |
| `source` | `"auto"` | `auto`: kanały z dekodera, a gdy się nie uda, z pliku playlisty. `decoder`: tylko z dekodera (błąd, jeśli niedostępny). `playlist`: tylko z pliku. |
| `bouquet` | `null` | Domyślnie wybrany bukiet (wystarczy fragment nazwy, np. `"polskie"`). `null` pokazuje wszystkie. |
| `playlist` | `"playlist.m3u8"` | Ścieżka do pliku playlisty (zapas). |
| `transcode` | `false` | `true`: ffmpeg przekodowuje też obraz (zalecane przy problemach z zawieszaniem). |
| `ffmpeg` | `null` | Ścieżka do ffmpeg, jeśli nie ma go w PATH. |
| `videoPreset` | `"veryfast"` | Preset x264 przy przekodowaniu (`ultrafast` zmniejsza użycie CPU kosztem jakości). |
| `audioBitrate` | `"128k"` | Bitrate dźwięku AAC. |

Pierwszeństwo mają flagi i zmienne środowiskowe: `PORT`, `--transcode`, `--no-transcode`, `--no-open`, `FFMPEG`, `NO_FFMPEG`. Potem `config.json`, a na końcu wartości domyślne.

Przykład: tylko dekoder, bez zapasu, start od bukietu „Sport”:

```json
{ "decoder": "192.168.0.233", "source": "decoder", "bouquet": "sport", "transcode": true }
```

### Formularz ustawień (⚙)

Przycisk ⚙ obok „Plik” otwiera formularz z tymi samymi opcjami, co `config.json`, więc nie trzeba edytować pliku ręcznie.

- **Testuj połączenie** sprawdza, czy pod podanym adresem i portem odpowiada OpenWebif, i pokazuje model dekodera.
- **Zapisz** zapisuje zmiany do `config.json` (inne klucze w pliku zostają nietknięte) i od razu przeładowuje listę kanałów. Opcje `port`, `ffmpeg` i `openBrowser` zadziałają dopiero po restarcie serwera, a formularz o tym informuje.
- Ustawienia można zmieniać **tylko z komputera, na którym działa serwer**. Z telefonu czy innego urządzenia formularz jest tylko do odczytu.
- Flagi `--transcode` i `--no-transcode` przy uruchomieniu wygrywają z ustawieniem w formularzu.

### Skórki

W formularzu ustawień wybierasz skórkę (Ciemny, Jasny, AMOLED, Granat, Bursztyn) i własny kolor akcentu. Wybór zapisuje się w przeglądarce, osobno dla każdego urządzenia.

### Kanały z dekodera

Przy `decoder` aplikacja pobiera bukiety i kanały prosto z OpenWebif (`/api/getallservices`), więc lista zawsze odpowiada temu, co masz w dekoderze, bez ręcznego eksportu. Nad wyszukiwarką jest lista bukietów. Numer przy kanale to pozycja w wybranym bukiecie, a wybór bukietu i ulubione zapamiętują się w przeglądarce. Markery z bukietów (separatory) są pomijane, a picony aplikacja pobiera z dekodera: pyta OpenWebif o adres piconu każdego kanału (`/api/getservices?picon=1`), więc działa też własna ścieżka i własne nazewnictwo piconów. Zapas to nazwa kanału małymi literami bez spacji (`tvp1hd.png`), a potem referencja (`1_0_1_3ABD_..._0.png`). Ile piconów podał dekoder, widać w terminalu serwera przy ładowaniu listy. Numer programu w multipleksie wyliczany jest z referencji kanału (czwarte pole, szesnastkowo).

## Obsługa

- **Bukiety:** lista rozwijana nad wyszukiwarką (gdy kanały idą z dekodera).
- **Szukaj w EPG:** zakładka „Szukaj” w panelu po prawej przeszukuje program dekodera (np. „mecz”, „film”). Kliknięcie wyniku przełącza na kanał, a „● Nagraj” dodaje timer.
- **Kanały:** kliknij w liście. Wyszukiwarka u góry filtruje po nazwie. Przycisk „Plik” wczytuje inną playlistę m3u/m3u8.
- **Ulubione:** gwiazdka ★ przypina kanał na górze listy. Zapisuje się w przeglądarce.
- **Numer kanału:** liczba przy nazwie to pozycja na liście. Wpisz cyfry, np. `12`, i poczekaj chwilę albo wciśnij Enter.
- **Teraz leci:** pod nazwą kanału widać bieżącą audycję (ładuje się dla widocznych kanałów).
- **EPG:** panel po prawej to program wybranego kanału. Kliknięcie audycji rozwija opis. Na górze obrazu jest „teraz/następnie” z paskiem postępu.
- **Nagrywanie:** przycisk „● Nagraj” przy audycji dodaje timer w dekoderze. Nagranie trafia na dysk dekodera, więc dekoder musi mieć podłączony dysk.

### Skróty klawiszowe

| Klawisz | Akcja |
|---|---|
| ↑ / ↓ | poprzedni / następny kanał |
| cyfry, Enter | skok do kanału o numerze |
| `F` lub dwuklik | pełny ekran |
| `M` | wyciszenie |
| `E` | pokaż/ukryj panel EPG |

## Jak to działa

1. Przeglądarka nie zagra surowego MPEG-TS z portu 8001, więc strumień przechodzi przez `server.js` (`/proxy?u=...`) i jest odtwarzany przez bibliotekę mpegts.js.
2. Dekoder oddaje na porcie 8001 cały multipleks (ok. 24 programy w jednym strumieniu). Numer programu to SID kanału (czwarte pole referencji w systemie szesnastkowym, np. `1:0:1:4288:...` to program 17032). W playliście jest to linia `#EXTVLCOPT:program=...`. Serwer wycina z multipleksu tylko ten program.
3. Dźwięk w polskich kanałach to zwykle MP2 albo AC3, a przeglądarka tego nie odtworzy. ffmpeg zamienia go na AAC.
4. EPG i timery to zapytania do API OpenWebif na dekoderze (`/api/epgservice`, `/api/epgservicenow`, `/api/timeraddbyeventid`), też przez proxy.

Proxy przepuszcza tylko adresy z sieci lokalnej (10.x, 192.168.x, 172.16–31.x). **Nie wystawiaj tego serwera do internetu**, bo nie ma uwierzytelniania.

## Gdy coś nie działa

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| `Failed to parse URL from /proxy...` | Masz starą wersję `index.html`. Podmień plik i odśwież Ctrl+F5. |
| Strona bez stylów (goły tekst) | Brak `style.css` obok `index.html` albo stary `server.js`, który go nie serwuje. Skopiuj plik i zrestartuj serwer. |
| Komunikat „Nie można pobrać kanałów z dekodera” | `source` ustawione na `decoder`, a dekoder jest wyłączony, ma inny adres IP albo OpenWebif na innym porcie. Sprawdź `decoder` i `webPort` w `config.json` oraz `http://IP_DEKODERA/` w przeglądarce. Z `source: auto` aplikacja sama przejdzie na plik playlisty. |
| Formularz ustawień jest nieaktywny | Otworzyłeś aplikację z innego urządzenia niż to, na którym działa serwer. Zmieniaj ustawienia na tym komputerze. |
| Serwer nie startuje i pisze `config.json: ...` | Błąd składni w `config.json` (np. przecinek na końcu, brak cudzysłowu). |
| Brak piconów przy kanałach | Sprawdź w terminalu linię `picony podane przez dekoder: N`. Dla `0` dekoder nie zna piconów (stare OpenWebif albo brak plików). Otwórz wtedy `http://IP_DEKODERA/picon/tvp1hd.png`: jeśli obrazek się ładuje, a w aplikacji go nie ma, daj znać, jak nazywa się plik w Twoim zestawie piconów. |
| Pusta lista albo „Wczytaj playlistę” | Brak `playlist.m3u8` obok `server.js`. Skopiuj plik albo użyj przycisku „Plik”. |
| Obraz stoi albo jest tylko pierwsza klatka, w konsoli `appendBuffer` i `HTMLMediaElement.error` | Błąd dekodowania. Uruchom z `--transcode`. Błąd widać też pod nazwą kanału w playerze. |
| Obraz jest, ale nie ma dźwięku | Najpierw sprawdź, czy nie jest wyciszony (klawisz `M`, suwak w playerze). Potem upewnij się, że ffmpeg jest wykryty (pierwsza linia serwera). |
| Serwer pisze „bez ffmpeg” | ffmpeg nie jest w PATH. Zainstaluj go i otwórz nowy terminal. |
| Terminal serwera zasypany `non-existing PPS` / `no frame!` | Normalne przy dołączaniu do strumienia w połowie. Jeśli obraz działa, ignoruj. |
| Przełączanie kanału trwa kilka sekund | Normalne z ffmpeg (analiza strumienia). Bez `--transcode` jest szybciej. |
| EPG pokazuje „Brak EPG” albo „Brak danych” | OpenWebif wyłączony albo dekoder nie ma EPG dla tego kanału. Sprawdź `http://IP_DEKODERA/` w przeglądarce. |
| Timer nie dodaje się | Komunikat z dekodera pojawia się na dole obrazu. Najczęściej brak dysku albo konflikt timerów. |
| Kanał nie gra, w terminalu błąd upstream | Dekoder wyłączony, zajęty tuner (zbyt wiele równoległych strumieni) albo zmieniony adres IP dekodera. |

Diagnostyka bez przeglądarki: `ffprobe "http://IP_DEKODERA:8001/REF_KANAŁU"` pokaże kodeki, rozdzielczość i przeplot. Ten sam adres można otworzyć w VLC.

## Playlista (opcjonalnie)

Przy `source: auto` plik `playlist.m3u8` służy tylko jako zapas, gdy dekoder jest niedostępny. Żeby go odświeżyć, wyeksportuj nową playlistę z dekodera i podmień plik (albo wczytaj ją przyciskiem „Plik”). Adresy IP są w niej zapisane na stałe.
