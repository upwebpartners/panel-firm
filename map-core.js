/* Selection data belongs to the team. Google place details stay in memory. */
(function (root) {
  'use strict';
  const C = root.CRMCore;
  const decisionFields = ['Mapa_status', 'Mapa_edytowal', 'Mapa_edytowano', 'Powod_wykreslenia'];
  function coordinates(value) {
    const lat = value.lat ?? value.Lat, lon = value.lon ?? value.Lon;
    if (lat === '' || lon === '' || lat == null || lon == null) return null;
    return Number.isFinite(+lat) && Number.isFinite(+lon) && Math.abs(+lat) <= 90 && Math.abs(+lon) <= 180 ? [+lat, +lon] : null;
  }
  function fromGoogle(place) {
    const lat = typeof place.location?.lat === 'function' ? place.location.lat() : place.location?.lat;
    const lon = typeof place.location?.lng === 'function' ? place.location.lng() : place.location?.lng;
    const point = coordinates({ lat, lon });
    if (!place.id || !point) throw new Error('Google nie zwrócił lokalizacji firmy.');
    return { id: place.id, name: place.displayName || '', lat: point[0], lon: point[1],
      address: place.formattedAddress || '', phone: place.nationalPhoneNumber || place.internationalPhoneNumber || '',
      website: C.safeURL(place.websiteURI), category: (place.types || []).join(', '), businessStatus: place.businessStatus || '' };
  }
  function placeURL(id) { return 'https://www.google.com/maps/search/?api=1&query=place&query_place_id=' + encodeURIComponent(id); }
  function matchRecord(entity, records) {
    const exact = records.find(r => r.Google_place_id === entity.id); if (exact) return exact;
    const candidates = records.filter(r => entity.name && C.norm(r.Firma) === C.norm(entity.name) &&
      ((entity.phone && r.Telefon && entity.phone.replace(/\D/g, '') === r.Telefon.replace(/\D/g, '')) ||
       (entity.website && C.safeURL(r.Strona).replace(/\/$/, '') === entity.website.replace(/\/$/, ''))));
    return candidates.length === 1 ? candidates[0] : null;
  }
  function state(record) {
    if (!record) return 'nowa';
    if (record.Mapa_status === 'wykreslona' || ['Odrzucony', 'Archiwum'].includes(record.Etap)) return 'wykreslona';
    return record.Mapa_status === 'przejrzana' ? 'przejrzana' : 'dodana';
  }
  function decision(record, value, author, reason = '', at = new Date().toISOString()) {
    if (!['T', 'K'].includes(author)) throw new Error('Tylko profil T lub K może zmienić wybór firmy.');
    if (!['przejrzana', 'dodana', 'wykreslona'].includes(value)) throw new Error('Nieprawidłowy wybór firmy.');
    if (value === 'przejrzana' && record && state(record) !== 'nowa') return {};
    return { Mapa_status: value, Mapa_edytowal: author, Mapa_edytowano: at,
      ...(value === 'wykreslona' ? { Etap: 'Odrzucony', Powod_wykreslenia: reason } : {}),
      ...(value === 'dodana' && (!record || state(record) !== 'dodana') ? { Etap: 'Do sprawdzenia' } : {}) };
  }
  function draft(entity) {
    // Do not persist Google names, phones, addresses, types or coordinates in CSV.
    return { Id: C.uid(), Firma: 'Do weryfikacji — ' + entity.id, Google_place_id: entity.id,
      Etap: 'Do sprawdzenia', Notatki: '', Status: 'Miejsce z mapy — uzupełnij dane z niezależnego źródła' };
  }
  root.MapCore = { decisionFields, coordinates, fromGoogle, placeURL, matchRecord, state, decision, draft };
})(globalThis);
