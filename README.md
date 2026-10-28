# Panel firm

Statyczny panel CRM do pracy z własnym CSV: lista firm, mapa, profile T/K,
historia telefonów, język polski i angielski oraz motyw jasny i ciemny.
Strona działa bez procesu budowania i bez instalowania pakietów npm.

## Uruchomienie lokalne

W katalogu projektu uruchom serwer statyczny (wymaga Pythona 3):

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Otwórz <http://127.0.0.1:8000>, wybierz **Wczytaj CSV** i wskaż swój plik.
Wybierz profil **T** lub **K**, aby zapisywać zmiany.

Bez połączenia z zewnętrzną bazą dane są zapisywane w tej przeglądarce.
Przycisk **Eksport CSV** pozwala pobrać kopię. Menu **Opcje → Wspólna baza
GitHub** umożliwia połączenie z repozytorium z danymi lub z lokalnym plikiem CSV.

## Struktura projektu

```text
.
├── index.html             # Interfejs, ikony i pusta struktura danych
├── assets/
│   ├── css/style.css      # Style, motywy i układ responsywny
│   └── js/                # Skrypty aplikacji
├── scripts/check.py       # Kontrola lokalnych odwołań i danych startowych
├── szablon-klientow.csv    # Szablon danych do uzupełnienia
└── .nojekyll              # Statyczna publikacja w GitHub Pages
```

| Plik w `assets/js/` | Odpowiedzialność |
| --- | --- |
| `translations.js` | Słownik tłumaczeń interfejsu |
| `i18n.js` | Wybór języka i tłumaczenie etykiet |
| `core.js` | CSV, scalanie zmian, sortowanie i historia telefonów |
| `map-core.js` | Dopasowywanie firm i decyzje dotyczące miejsc na mapie |
| `storage.js` | Walidacja i zapis lokalnej kopii danych |
| `network.js` | Limit czasu operacji sieciowych |
| `github.js` | Odczyt i zapis CSV przez GitHub |
| `app.js` | Stan aplikacji, lista firm, formularze i obsługa zdarzeń |
| `ui.js` | Motyw, język i nawigacja między zakładkami |
| `map.js` | Integracja Google Maps i obsługa mapy |

Skrypty są ładowane jako zwykłe skrypty przeglądarkowe. Kolejność w `index.html`
odpowiada kolejności w tabeli: tłumaczenia poprzedzają `i18n.js`, warstwa danych
poprzedza `app.js`, a obsługa mapy korzysta z gotowego interfejsu aplikacji.
Po przenoszeniu plików zaktualizuj ich ścieżki w `index.html`.

## Weryfikacja zmian

Z dowolnego katalogu można uruchomić skrypt, podając jego ścieżkę. Z katalogu
projektu:

```sh
python3 scripts/check.py
```

Skrypt sprawdza lokalne odwołania w HTML i CSS, identyfikatory elementów,
dane startowe i strukturę szablonu CSV. Nie wymaga dodatkowych bibliotek.
Nie zastępuje sprawdzenia działania JavaScript w przeglądarce.

Po zmianach w interfejsie sprawdź import i eksport CSV, zapis pod profilem T/K,
zmianę motywu i języka oraz przełączanie między listą i mapą.
Mapa wymaga własnego klucza Google; formularz ustawień opisuje konfigurację.

## Dane i ustawienia

Repozytorium zawiera pustą listę firm. W pliku `szablon-klientow.csv` zastąp
`[Nazwa firmy]` i `[Twoje notatki i ustalenia]` swoimi danymi albo usuń przykładowy
wiersz przed importem.

Opcjonalny `klienci.csv` w katalogu głównym jest automatycznie wczytywany przez
stronę. Plik jest ignorowany przez Git, aby lokalna baza nie trafiała przypadkiem
do repozytorium. Jeśli świadomie publikujesz CSV obok strony, będzie on dostępny
pod jej adresem. Bazę współdzieloną można przechowywać w osobnym repozytorium.

Zachowuj istniejące klucze pamięci przeglądarki (`pracownia.*` i `atlas.*`), aby
aktualizacje nie odcinały dostępu do zapisanych danych i preferencji.
Token GitHub i klucz mapy pozostają w pamięci otwartej karty.

## Publikacja

GitHub Pages: gałąź `main`, katalog główny (`/`). Przy ręcznej aktualizacji
prześlij `index.html`, cały katalog `assets/`, `.nojekyll` i szablon CSV,
zachowując ich strukturę. Publikacja nie wymaga skryptu budowania.
