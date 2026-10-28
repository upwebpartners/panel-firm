#!/usr/bin/env python3
"""Sprawdź strukturę statycznej strony bez dodatkowych zależności."""

import csv
import json
import re
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent.parent


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.ids = Counter()
        self.references = []
        self.initial_data = []
        self.reading_initial_data = False
        self.feed(text)
        self.close()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids[attrs["id"]] += 1
        for name in ("src", "href"):
            if attrs.get(name):
                self.references.append(attrs[name])
        if tag == "script":
            self.reading_initial_data = attrs.get("id") == "initial-data"

    def handle_endtag(self, tag):
        if tag == "script":
            self.reading_initial_data = False

    def handle_data(self, data):
        if self.reading_initial_data:
            self.initial_data.append(data)


def check_reference(reference, source, ids=None):
    url = urlsplit(reference)
    if url.scheme or url.netloc:
        return
    if url.path:
        target = (ROOT if url.path.startswith("/") else source.parent) / unquote(
            url.path.lstrip("/")
        )
        if not target.is_file():
            raise ValueError(f"{source.relative_to(ROOT)}: brak pliku {reference}")
    elif url.fragment and ids is not None and unquote(url.fragment) not in ids:
        raise ValueError(f"{source.relative_to(ROOT)}: brak elementu {reference}")


def check():
    html = ROOT / "index.html"
    page = Page(html.read_text(encoding="utf-8"))
    duplicates = [key for key, count in page.ids.items() if count > 1]
    if duplicates:
        raise ValueError("Powtórzone identyfikatory HTML: " + ", ".join(duplicates))
    for reference in page.references:
        check_reference(reference, html, page.ids)

    styles = list((ROOT / "assets" / "css").rglob("*.css"))
    for style in styles:
        text = re.sub(r"/\*.*?\*/", "", style.read_text(encoding="utf-8"), flags=re.S)
        for match in re.finditer(r"url\(\s*(['\"]?)(.*?)\1\s*\)", text):
            check_reference(match[2].strip(), style)

    seed = json.loads("".join(page.initial_data))
    headers, records = seed["headers"], seed["records"]
    if not isinstance(headers, list) or not all(isinstance(h, str) for h in headers):
        raise ValueError("Dane startowe: nagłówki muszą być listą tekstów.")
    if "Firma" not in headers or len(headers) != len(set(headers)):
        raise ValueError("Dane startowe: brak kolumny Firma lub powtórzone nagłówki.")
    if not isinstance(records, list) or any(
        not isinstance(row, dict)
        or not all(isinstance(value, str) for value in row.values())
        for row in records
    ):
        raise ValueError("Dane startowe: rekordy muszą zawierać pola tekstowe.")

    with (ROOT / "szablon-klientow.csv").open(encoding="utf-8-sig", newline="") as file:
        rows = list(csv.reader(file, strict=True))
    if not rows or rows[0] != headers:
        raise ValueError("Szablon CSV ma inne nagłówki niż dane startowe.")
    if any(len(row) != len(headers) for row in rows[1:]):
        raise ValueError("Szablon CSV ma wiersz z niewłaściwą liczbą kolumn.")

    print("OK: odwołania HTML i CSS, identyfikatory, dane startowe i szablon CSV.")


if __name__ == "__main__":
    try:
        check()
    except (OSError, ValueError, KeyError, TypeError, csv.Error) as error:
        print(f"BŁĄD: {error}", file=sys.stderr)
        sys.exit(1)
